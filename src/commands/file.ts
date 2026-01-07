import { Command } from "./types";
import { postMessage } from "../slack";
import { recordFileProcessing } from "../telemetry";
import { extractFileContent, titleFromFilename } from "../files";
import { addDocument } from "../docs";

export const fileCommand: Command = {
  name: "file",
  match: (event) => {
    return !!event.files && event.files.length > 0;
  },
  execute: async (event, botUserId, env) => {
    const { user, channel, thread_ts, ts, files } = event;
    const threadTs = thread_ts ?? ts;

    const fileNames = files!.map((f) => f.name).join(", ");
    await postMessage(channel, `📄 Processing ${files!.length > 1 ? "files" : "file"}: ${fileNames}...`, threadTs, env);

    const results: string[] = [];

    for (const file of files!) {
      try {
        const extracted = await extractFileContent(file, env);
        if (extracted) {
          const title = titleFromFilename(extracted.filename);
          const result = await addDocument(env, title, extracted.content, user);
          results.push(result.message);
          recordFileProcessing({
            fileName: file.name,
            fileType: file.mimetype,
            fileSizeKb: Math.round((file.size || 0) / 1024),
            extractedLength: extracted.content.length,
            success: true,
          });
        } else {
          results.push(`Couldn't extract text from "${file.name}" (unsupported format or empty).`);
          recordFileProcessing({
            fileName: file.name,
            fileType: file.mimetype,
            fileSizeKb: Math.round((file.size || 0) / 1024),
            success: false,
            errorMessage: "unsupported format or empty",
          });
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        results.push(`Error processing "${file.name}": ${errMsg}`);
        recordFileProcessing({
          fileName: file.name,
          fileType: file.mimetype,
          fileSizeKb: Math.round((file.size || 0) / 1024),
          success: false,
          errorMessage: errMsg,
        });
      }
    }

    await postMessage(channel, results.join("\n"), threadTs, env);
  },
};
