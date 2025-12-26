/**
 * File handling for Chorus
 *
 * Downloads files from Slack and extracts text content.
 * Uses Claude's document understanding for PDFs.
 */

import type { Env, SlackFile } from "./types";

export interface ExtractedFile {
  filename: string;
  content: string;
  charCount: number;
}

/**
 * Download a file from Slack using the bot token
 */
async function downloadSlackFile(file: SlackFile, env: Env): Promise<ArrayBuffer> {
  const url = file.url_private_download || file.url_private;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }

  return response.arrayBuffer();
}

/**
 * Extract text from a PDF using Claude's document understanding
 */
async function extractPdfWithClaude(buffer: ArrayBuffer, env: Env): Promise<string> {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
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
              text: "Extract all the text content from this document. Return only the extracted text, preserving the structure and formatting as much as possible. Do not add any commentary or explanations.",
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
  return data.content[0]?.text ?? "";
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

  if (!isPdf && !isText) {
    return null;
  }

  try {
    console.log(`Downloading file: ${file.name} (${file.mimetype})`);
    const buffer = await downloadSlackFile(file, env);
    console.log(`Downloaded ${buffer.byteLength} bytes`);

    let content: string;
    if (isPdf) {
      console.log("Extracting PDF with Claude...");
      content = await extractPdfWithClaude(buffer, env);
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
