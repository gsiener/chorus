/**
 * File handling for Chorus
 *
 * Downloads files from Slack and extracts text content.
 * Uses Claude's document understanding for PDFs.
 */

import type { Env, SlackFile } from "./types";

// File size limits
const MAX_FILE_SIZE = 1024 * 1024; // 1MB max file size
const DOWNLOAD_TIMEOUT_MS = 10000; // 10 second timeout for downloads

export interface ExtractedFile {
  filename: string;
  content: string;
  charCount: number;
}

/**
 * Mask sensitive parts of URLs for safe logging
 */
function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Download a file from Slack using the bot token
 * Handles redirects by manually following them with auth headers
 */
async function downloadSlackFile(file: SlackFile, env: Env): Promise<ArrayBuffer> {
  // Check file size before downloading
  if (file.size && file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${Math.round(file.size / 1024)}KB). Max size is ${MAX_FILE_SIZE / 1024}KB.`);
  }

  let url = file.url_private_download || file.url_private;
  console.log(`Fetching file: ${file.name} from ${maskUrl(url)}`);

  // Follow redirects manually to preserve auth header
  let response: Response;
  let redirectCount = 0;
  const maxRedirects = 5;

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    while (redirectCount < maxRedirects) {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        },
        redirect: 'manual',
        signal: controller.signal,
      });

      console.log(`Response status: ${response.status}`);

      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect without location header`);
        }
        console.log(`Following redirect`);
        url = location;
        redirectCount++;
        continue;
      }

      break;
    }
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response!.ok) {
    throw new Error(`Failed to download file: ${response!.status}`);
  }

  const buffer = await response!.arrayBuffer();

  // Validate downloaded size
  if (buffer.byteLength > MAX_FILE_SIZE) {
    throw new Error(`Downloaded file too large (${Math.round(buffer.byteLength / 1024)}KB). Max size is ${MAX_FILE_SIZE / 1024}KB.`);
  }

  // Check if we got HTML instead of the file (auth redirect)
  const firstBytes = new Uint8Array(buffer.slice(0, 20));
  const header = String.fromCharCode(...firstBytes);

  if (header.includes('<!DOCTYPE') || header.includes('<html')) {
    throw new Error('Got HTML instead of file - auth may have failed');
  }

  return buffer;
}

/**
 * Upload file to Anthropic Files API and get file_id
 */
async function uploadToAnthropicFiles(buffer: ArrayBuffer, filename: string, env: Env): Promise<string> {
  console.log(`Uploading ${filename} to Anthropic Files API...`);

  // Create form data with the file
  const formData = new FormData();
  const blob = new Blob([buffer], { type: "application/pdf" });
  formData.append("file", blob, filename);

  const response = await fetch("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "files-api-2025-04-14",
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Files API upload error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as { id: string };
  console.log(`File uploaded, id: ${data.id}`);
  return data.id;
}

/**
 * Convert ArrayBuffer to base64 in chunks (to avoid stack overflow)
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32768;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Extract text from a PDF using Claude with base64 and streaming
 */
async function extractPdfWithClaude(buffer: ArrayBuffer, filename: string, env: Env): Promise<string> {
  // Verify PDF magic bytes
  const header = new Uint8Array(buffer.slice(0, 5));
  const pdfMagic = String.fromCharCode(...header);
  console.log(`PDF magic bytes: "${pdfMagic}"`);

  if (!pdfMagic.startsWith('%PDF')) {
    throw new Error(`Not a valid PDF file (header: ${pdfMagic})`);
  }

  // Convert to base64
  const base64 = arrayBufferToBase64(buffer);
  console.log(`Base64 encoded: ${base64.length} chars`);

  console.log("Calling Claude API with base64 PDF and streaming...");
  const startTime = Date.now();

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "pdfs-2024-09-25",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 8192,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            },
            {
              type: "text",
              text: "Extract all text from this PDF. Return only the text content.",
            },
          ],
        },
      ],
    }),
  });

  console.log(`Claude API initial response in ${Date.now() - startTime}ms, status: ${response.status}`);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  // Process the stream
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let extractedText = "";
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunkCount++;
    const chunk = decoder.decode(value, { stream: true });

    // Parse SSE events - each line starts with "data: " followed by JSON
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          // Extract text from content_block_delta events
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            extractedText += event.delta.text;
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    }
  }

  console.log(`Streaming complete: ${chunkCount} chunks, ${extractedText.length} chars in ${Date.now() - startTime}ms`);
  return extractedText;
}

/**
 * Extract text from supported file types
 */
export async function extractFileContent(
  file: SlackFile,
  env: Env
): Promise<ExtractedFile | null> {
  const textMimeTypes = [
    "text/plain",
    "text/markdown",
    "application/json",
    "text/csv",
  ];

  // Check if we support this file type
  const isPdf = file.filetype === "pdf" || file.mimetype === "application/pdf";
  const isText =
    textMimeTypes.includes(file.mimetype) ||
    file.mimetype.startsWith("text/");

  if (isPdf) {
    // PDF processing times out in Cloudflare Workers - guide user to use text command
    throw new Error('PDF upload not supported yet. Please copy the text from your PDF and use: @Chorus add doc "Title": [paste text here]');
  }

  if (!isText) {
    return null;
  }

  try {
    console.log(`Downloading file: ${file.name} (${file.mimetype})`);
    const buffer = await downloadSlackFile(file, env);
    console.log(`Downloaded ${buffer.byteLength} bytes`);

    let content: string;
    if (isPdf) {
      console.log("Extracting PDF with Claude Files API...");
      content = await extractPdfWithClaude(buffer, file.name, env);
      console.log(`Extracted ${content.length} chars from PDF`);
    } else {
      // Text file - decode as UTF-8
      const decoder = new TextDecoder("utf-8");
      content = decoder.decode(buffer);
    }

    // Clean up the content
    content = content.trim();

    if (!content) {
      console.log("Extracted content was empty");
      return null;
    }

    return {
      filename: file.name,
      content,
      charCount: content.length,
    };
  } catch (error) {
    console.error(`Failed to extract content from ${file.name}:`, error);
    throw error;
  }
}

/**
 * Get a title from filename (remove extension)
 */
export function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}
