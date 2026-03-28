/**
 * FileStreamBot - Cloudflare Workers Implementation
 *
 * This worker implements a Telegram file-to-link bot that generates signed
 * stream/download links without requiring MongoDB Data API credentials.
 *
 * Environment Variables Required:
 * - MONGODB_URI: Used as signing secret for secure file links
 * - BOT_TOKEN: Telegram Bot API token
 * - OWNER_ID: Telegram user ID of the bot owner
 * - WORKER_URL: Base URL of the Cloudflare Worker
 */

const TELEGRAM_API = 'https://api.telegram.org';
const LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Main Request Handler
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Validate required environment variables
    if (!env.MONGODB_URI || !env.BOT_TOKEN || !env.OWNER_ID || !env.WORKER_URL) {
      return new Response(JSON.stringify({
        error: 'Missing required environment variables',
        required: ['MONGODB_URI', 'BOT_TOKEN', 'OWNER_ID', 'WORKER_URL']
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Health check and root
    if (pathname === '/' || pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'running',
        service: 'FileStreamBot',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Webhook endpoint for Telegram updates
    if (pathname === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        ctx.waitUntil(handleWebhookUpdate(update, env));
        return new Response('OK', { status: 200 });
      } catch (err) {
        console.error('Webhook error:', err);
        return new Response('Error', { status: 500 });
      }
    }

    // Streaming and Download endpoints
    if (pathname.startsWith('/dl/') || pathname.startsWith('/watch/')) {
      const parts = pathname.split('/');
      const signedToken = parts[2];
      const isWatch = pathname.startsWith('/watch/');
      return handleFileRequest(signedToken, isWatch, request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * ==================== TELEGRAM HANDLERS ====================
 */

/**
 * Handle Telegram Webhook Updates
 */
async function handleWebhookUpdate(update, env) {
  const message = update.message || update.channel_post;
  if (!message) return;

  const chatId = message.chat.id;
  const userId = message.from ? message.from.id : chatId;

  // Check authorization (owner only for now)
  if (env.OWNER_ID && userId.toString() !== env.OWNER_ID.toString()) {
    return;
  }

  // Handle /start command
  if (message.text === '/start') {
    const startText = `
👋 <b>Welcome to FileStreamBot!</b>

I'm a Telegram file to direct link converter. Send me any file and I'll generate direct streaming and download links for you.

📋 <b>How to use:</b>
1. Send any file to this bot
2. I'll generate direct links
3. Share the links anywhere!

⚙️ <b>Features:</b>
✅ Direct file links
✅ Stream support
✅ Range request support
✅ Fast delivery
✅ 7-day link expiration
✅ No external database API key needed

🔒 <b>Privacy:</b> Your files are processed securely.
    `.trim();
    await sendTelegramMessage(chatId, startText, env);
    return;
  }

  // Handle File Uploads
  const file = message.document || message.video || message.audio || message.photo || message.animation;
  if (file) {
    await handleFileUpload(file, chatId, env);
    return;
  }

  // Handle text messages
  if (message.text) {
    await sendTelegramMessage(chatId, '📁 Please send a file (document, video, audio, photo, animation, etc.)', env);
  }
}

/**
 * Handle File Upload
 */
async function handleFileUpload(file, chatId, env) {
  try {
    const fileObj = Array.isArray(file) ? file[file.length - 1] : file;
    const filePayload = {
      file_id: fileObj.file_id,
      file_name: fileObj.file_name || `file_${Date.now()}`,
      file_size: fileObj.file_size || 0,
      mime_type: fileObj.mime_type || 'application/octet-stream',
      exp: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS
    };

    // Generate signed file token
    const signedToken = await createSignedFileToken(filePayload, env.MONGODB_URI);

    // Generate links
    const streamLink = `${env.WORKER_URL}/watch/${signedToken}`;
    const downloadLink = `${env.WORKER_URL}/dl/${signedToken}`;

    // Create response message
    const responseText = `
✅ <b>File Processed Successfully!</b>

📄 <b>File Name:</b> <code>${escapeHtml(filePayload.file_name)}</code>
📊 <b>File Size:</b> <code>${formatBytes(filePayload.file_size)}</code>
⏱️ <b>Expires:</b> <code>7 days</code>

<b>Share these links:</b>
🎬 <a href="${streamLink}">Stream Link</a>
📥 <a href="${downloadLink}">Download Link</a>
    `.trim();

    const replyMarkup = {
      inline_keyboard: [[
        { text: '🎬 Stream', url: streamLink },
        { text: '📥 Download', url: downloadLink }
      ]]
    };

    await sendTelegramMessage(chatId, responseText, env, replyMarkup);
  } catch (error) {
    console.error('Error handling file upload:', error);
    await sendTelegramMessage(chatId, `❌ Error: ${error.message}`, env);
  }
}

/**
 * ==================== FILE STREAMING ====================
 */

/**
 * Handle File Streaming/Download Requests
 */
async function handleFileRequest(signedToken, isWatch, request, env) {
  try {
    // Validate token and extract file metadata
    const fileData = await verifySignedFileToken(signedToken, env.MONGODB_URI);
    if (!fileData) {
      return new Response('Invalid or expired link', { status: 401 });
    }

    const { file_id, file_name, mime_type } = fileData;

    // Get File Path from Telegram
    const fileInfoResp = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/getFile?file_id=${file_id}`);
    const fileInfo = await fileInfoResp.json();

    if (!fileInfo.ok) {
      return new Response('Telegram API Error', { status: 500 });
    }

    const filePath = fileInfo.result.file_path;
    const fileUrl = `${TELEGRAM_API}/file/bot${env.BOT_TOKEN}/${filePath}`;

    // Handle Range Requests
    const range = request.headers.get('Range');
    const headers = new Headers();
    if (range) {
      headers.set('Range', range);
    }

    // Fetch file from Telegram
    const fileResp = await fetch(fileUrl, { headers });

    if (!fileResp.ok) {
      return new Response('Failed to fetch file from Telegram', { status: 500 });
    }

    // Prepare response headers
    const responseHeaders = new Headers(fileResp.headers);
    responseHeaders.set('Content-Disposition', `${isWatch ? 'inline' : 'attachment'}; filename="${escapeHtml(file_name)}"`);
    responseHeaders.set('Content-Type', mime_type || 'application/octet-stream');
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('Cache-Control', 'public, max-age=3600');

    return new Response(fileResp.body, {
      status: fileResp.status,
      headers: responseHeaders
    });
  } catch (error) {
    console.error('Error handling file request:', error);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}

/**
 * ==================== TOKEN HELPERS ====================
 */

function toBase64Url(input) {
  const b64 = btoa(input);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input) {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4 || 4)) % 4);
  return atob(padded);
}

async function hmacSha256(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return toBase64Url(String.fromCharCode(...new Uint8Array(signature)));
}

async function createSignedFileToken(payload, secret) {
  const body = toBase64Url(JSON.stringify(payload));
  const sig = await hmacSha256(body, secret);
  return `${body}.${sig}`;
}

async function verifySignedFileToken(token, secret) {
  const [body, sig] = token.split('.');
  if (!body || !sig) {
    return null;
  }

  const expectedSig = await hmacSha256(body, secret);
  if (sig !== expectedSig) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(body));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) {
    return null;
  }

  return payload;
}

/**
 * ==================== TELEGRAM API HELPERS ====================
 */

/**
 * Send message to Telegram
 */
async function sendTelegramMessage(chatId, text, env, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  try {
    const response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.error('Failed to send Telegram message:', await response.text());
    }
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

/**
 * ==================== UTILITY FUNCTIONS ====================
 */

/**
 * Format bytes to human-readable format
 */
function formatBytes(bytes, decimals = 2) {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const rawText = String(text ?? '');
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return rawText.replace(/[&<>"']/g, m => map[m]);
}
