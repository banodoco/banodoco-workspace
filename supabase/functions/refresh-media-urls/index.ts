/**
 * Supabase Edge Function: Refresh Discord Media URLs
 *
 * Discord CDN attachment URLs expire after some time. This function:
 * 1. Takes a message_id (and optionally channel_id/thread_id)
 * 2. Looks up the message in the database to get channel info
 * 3. Fetches fresh URLs from Discord API
 * 4. Updates the database with the new URLs
 * 5. Returns the refreshed URLs
 *
 * Required secrets:
 *   - DISCORD_BOT_TOKEN: Your Discord bot token
 *
 * Usage:
 *   POST /functions/v1/refresh-media-urls
 *   Body (JSON):
 *     {
 *       "message_id": "123456789",           // Required: Discord message ID
 *       "channel_id": "987654321",           // Optional: override channel ID
 *       "thread_id": "111222333"             // Optional: thread ID for forum posts
 *     }
 *
 *   Response:
 *     {
 *       "success": true,
 *       "message_id": "123456789",
 *       "attachments": [...],                // Array of refreshed attachment objects
 *       "urls_updated": 2                    // Number of URLs that changed
 *     }
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface Attachment {
  id?: string;
  filename?: string;
  url?: string;
  proxy_url?: string;
  size?: number;
  content_type?: string;
  height?: number;
  width?: number;
}

interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  proxy_url: string;
  size: number;
  content_type?: string;
  height?: number;
  width?: number;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  attachments: DiscordAttachment[];
}

// Discord CDN URLs carry an `ex` query param that is a HEX-encoded unix-seconds
// expiry (e.g. `?ex=6a74a4dc`). A URL is "fresh" only if its expiry is still
// more than *marginSec* in the future. URLs without an `ex` param (or with an
// unparseable one) are treated as stale. Defensive: parse decimal when the
// value is all digits, otherwise hex (Discord's format). An all-digit hex value
// misread as a tiny decimal simply yields "not fresh" -> a safe redundant
// refresh, never a dead URL served as cached.
function isUrlFresh(url?: string, marginSec = 3600): boolean {
  if (!url) return false;
  const m = url.match(/[?&]ex=([0-9a-fA-F]+)/);
  if (!m) return false;
  const raw = m[1];
  const ex = /^\d+$/.test(raw) ? Number(raw) : parseInt(raw, 16);
  if (!Number.isFinite(ex) || ex <= 0) return false;
  return ex > Math.floor(Date.now() / 1000) + marginSec;
}

// Fetch message from Discord API
async function fetchDiscordMessage(
  token: string,
  channelId: string,
  messageId: string
): Promise<DiscordMessage | null> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[fetchDiscordMessage] ${response.status} for message ${messageId}: ${errorText}`);
    if (response.status === 404) {
      return null;
    }
    throw new Error(
      `Discord API error ${response.status}: ${response.statusText} - ${errorText}`
    );
  }

  return (await response.json()) as DiscordMessage;
}

// Main handler
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get Discord token from secrets
    const discordToken = Deno.env.get("DISCORD_BOT_TOKEN");
    if (!discordToken) {
      return new Response(
        JSON.stringify({ success: false, error: "DISCORD_BOT_TOKEN not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Initialize Supabase client with service role (for DB updates)
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SB_SECRET_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body
    const rawBody = await req.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid JSON body" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    
    // Convert to string to preserve precision for big integers
    const messageId = body.message_id?.toString();
    let channelId = body.channel_id?.toString();
    let threadId = body.thread_id?.toString();

    if (!messageId) {
      return new Response(
        JSON.stringify({ success: false, error: "message_id is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Anti-spam throttle (schema: media_refresh_log + media_refresh_state +
    // check_and_record_refresh). Reject malformed/out-of-range ids up front;
    // gate every call through the RPC (24h freshness cache, global 60/min,
    // per-IP 10/min). FAIL CLOSED: if the throttle gate is unavailable we
    // refuse the refresh rather than run an unthrottled public function.
    if (!/^\d{17,19}$/.test(messageId)) {
      return new Response(
        JSON.stringify({ success: false, error: "invalid message_id" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    try {
      if (BigInt(messageId) > 9223372036854775807n) {
        throw new Error("out of range");
      }
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "invalid message_id" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    const callerIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const { data: throttle, error: throttleError } = await supabase
      .rpc("check_and_record_refresh", { p_message_id: messageId, p_caller_ip: callerIp })
      .single();
    // FAIL CLOSED: if the throttle gate is unavailable, do not accept the
    // refresh (an unthrottled public function is a spam target).
    if (throttleError || !throttle) {
      console.error(`[refresh-media-urls] throttle check failed for ${messageId}: ${throttleError?.message}`);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Refresh temporarily unavailable; try again shortly",
          message_id: messageId,
        }),
        {
          status: 503,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Retry-After": "30",
          },
        }
      );
    }
    const freshUrl = throttle.fresh === true;
    if (!throttle.allowed) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Rate limit: ${throttle.reason}`,
          message_id: messageId,
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Retry-After": String(throttle.retry_after ?? 60),
          },
        }
      );
    }

    // Look up the message in the database to get channel info if not provided
    // Use RPC to cast BIGINTs to TEXT to avoid JavaScript precision loss
    const { data: dbMessage, error: dbError } = await supabase
      .rpc("get_message_for_refresh", { p_message_id: messageId })
      .single();

    if (dbError || !dbMessage) {
      console.error(`[refresh-media-urls] Message ${messageId} not found: ${dbError?.message}`);
      return new Response(
        JSON.stringify({
          success: false,
          error: `Message ${messageId} not found in database`,
          db_error: dbError?.message || null,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Use DB values if not provided in request (convert to string for Discord API)
    channelId = channelId || dbMessage.channel_id?.toString();
    threadId = threadId || dbMessage.thread_id?.toString();

    // Parse existing attachments
    let oldAttachments: Attachment[] = [];
    if (dbMessage.attachments) {
      if (typeof dbMessage.attachments === "string") {
        try {
          oldAttachments = JSON.parse(dbMessage.attachments);
        } catch {
          oldAttachments = [];
        }
      } else if (Array.isArray(dbMessage.attachments)) {
        oldAttachments = dbMessage.attachments;
      }
    }

    if (oldAttachments.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message_id: messageId,
          attachments: [],
          urls_updated: 0,
          note: "Message has no attachments in database",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fresh within 24h AND URLs still valid? Deliver the SAME URL without
    // calling Discord (avoids redundant re-signing). A URL whose `ex` is
    // already near/at expiry falls through to a real refresh below.
    if (freshUrl && oldAttachments.every((a) => isUrlFresh(a.url))) {
      return new Response(
        JSON.stringify({
          success: true,
          message_id: messageId,
          attachments: oldAttachments,
          urls_updated: 0,
          cached: true,
          note: "Attachment URLs were refreshed within the last 24 hours and are still valid; returning existing URLs",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    if (freshUrl) {
      // Marked fresh but a URL is near/at expiry -> this is a REAL refresh and
      // must be counted/gated (Codex blocker: uncounted fall-through refreshes
      // would bypass the caps). Force-count now; 429 if over any cap.
      console.log(
        `[refresh-media-urls] Message ${messageId} within 24h window but URLs near/at expiry; refreshing`
      );
      const { data: force, error: forceError } = await supabase
        .rpc("check_and_record_refresh", { p_message_id: messageId, p_caller_ip: callerIp, p_force_count: true })
        .single();
      if (forceError || !force) {
        console.error(`[refresh-media-urls] force-count throttle failed for ${messageId}: ${forceError?.message}`);
        return new Response(
          JSON.stringify({ success: false, error: "Refresh temporarily unavailable; try again shortly", message_id: messageId }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "30" } }
        );
      }
      if (!force.allowed) {
        return new Response(
          JSON.stringify({ success: false, error: `Rate limit: ${force.reason}`, message_id: messageId }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": String(force.retry_after ?? 60) } }
        );
      }
    }

    // Try fetching from Discord - first try channel_id
    let discordMessage = await fetchDiscordMessage(
      discordToken,
      channelId,
      messageId
    );

    // If that fails and we have a thread_id, try that (for forum posts)
    if (!discordMessage && threadId) {
      discordMessage = await fetchDiscordMessage(
        discordToken,
        threadId,
        messageId
      );
    }

    if (!discordMessage) {
      console.error(`[refresh-media-urls] Message ${messageId} not found on Discord (channel: ${channelId})`);
      return new Response(
        JSON.stringify({
          success: false,
          error: "Could not fetch message from Discord. It may have been deleted.",
          message_id: messageId,
          channel_id: channelId,
          thread_id: threadId || null,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
    
    // Build new attachments array, preserving structure
    const newAttachments: Attachment[] = discordMessage.attachments.map(
      (att) => ({
        id: att.id,
        filename: att.filename,
        url: att.url,
        proxy_url: att.proxy_url,
        size: att.size,
        content_type: att.content_type,
        height: att.height,
        width: att.width,
      })
    );

    if (newAttachments.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message_id: messageId,
          attachments: [],
          urls_updated: 0,
          note: "Message no longer has attachments on Discord",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Count how many URLs changed
    const oldUrlSet = new Set(oldAttachments.map((a) => a.url).filter(Boolean));
    const newUrlSet = new Set(newAttachments.map((a) => a.url).filter(Boolean));
    let urlsChanged = 0;
    for (const url of newUrlSet) {
      if (!oldUrlSet.has(url)) {
        urlsChanged++;
      }
    }

    // Update the database with new attachments
    const { error: updateError } = await supabase
      .from("discord_messages")
      .update({ attachments: newAttachments })
      .eq("message_id", messageId);

    if (updateError) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `Database update failed: ${updateError.message}`,
          message_id: messageId,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log(
      `Updated message ${messageId}: ${newAttachments.length} attachments, ${urlsChanged} URLs changed`
    );

    // Mark this message's URL as freshly refreshed (24h cached-delivery window).
    // Best effort — a failure here only means the next call re-refreshes.
    const { error: markError } = await supabase.rpc("mark_refresh_done", {
      p_message_id: messageId,
    });
    if (markError) {
      console.error(`[refresh-media-urls] mark_refresh_done failed for ${messageId}: ${markError.message}`);
    }

    // Return success with the new URLs
    return new Response(
      JSON.stringify({
        success: true,
        message_id: messageId,
        attachments: newAttachments,
        urls_updated: urlsChanged,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Refresh failed",
        detail: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
