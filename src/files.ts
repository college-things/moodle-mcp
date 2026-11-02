import { lstat, realpath } from "node:fs/promises";
import { basename, extname, sep } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { htmlToText } from "./moodle.js";

const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const PLAIN_TEXT = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".py", ".java", ".c", ".cpp", ".h", ".js", ".ts", ".sql", ".tex", ".rtf"]);

/** Word order inside Office XML follows the document, so tags can be replaced where they stand. */
function officeXmlToText(xml: string, paragraphEnd: RegExp): string {
  return htmlToText(xml.replace(paragraphEnd, "<br>"));
}

function officeText(bytes: Uint8Array, ext: string): string {
  const wanted: Record<string, RegExp> = {
    ".docx": /^word\/(document|footnotes)\.xml$/,
    ".pptx": /^ppt\/slides\/slide\d+\.xml$/,
    ".xlsx": /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/,
  };
  let total = 0;
  const entries = unzipSync(bytes, {
    filter: (file) => {
      if (!wanted[ext].test(file.name)) return false;
      total += file.originalSize;
      if (total > MAX_UNZIPPED_BYTES) throw new Error("This file unpacks to too much data to read.");
      return true;
    },
  });
  const byNumber = (a: string, b: string): number => Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0);
  return Object.keys(entries)
    .sort(byNumber)
    .map((name) => officeXmlToText(strFromU8(entries[name]), /<\/(w:p|a:p|si|row)>/g))
    .join("\n\n");
}

/** Text of a downloaded file, or null when this format can only be saved. */
export async function extractText(bytes: Buffer, filename: string, contentType: string): Promise<string | null> {
  const ext = extname(filename).toLowerCase();
  if (ext === ".pdf" || contentType.includes("application/pdf")) {
    const { text } = await extractPdfText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false });
    return (text as string[]).map((page, i) => `[page ${i + 1}]\n${page}`).join("\n\n");
  }
  if (ext === ".docx" || ext === ".pptx" || ext === ".xlsx") return officeText(bytes, ext);
  if (ext === ".html" || ext === ".htm" || contentType.includes("text/html")) return htmlToText(bytes.toString("utf8"));
  if (PLAIN_TEXT.has(ext) || contentType.startsWith("text/")) return bytes.toString("utf8");
  return null;
}

/**
 * Text from a course page can talk an assistant into uploading the wrong file, and teachers
 * would receive it. Hidden folders and key files are where a computer keeps its secrets.
 */
export async function checkUploadPath(path: string, maxBytes: number): Promise<{ path: string; name: string; size: number }> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new Error(`Cannot read ${path}: no such file.`);
  }
  const name = basename(real);
  const hidden = real.split(sep).some((part) => part.startsWith("."));
  if (hidden || /^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|kdbx|keychain)$/i.test(name)) {
    throw new Error(`Refusing to upload ${path}: it is in a hidden folder or looks like a credential file. Copy homework to a normal folder first.`);
  }
  const info = await lstat(real);
  if (!info.isFile()) throw new Error(`Cannot upload ${path}: it is not a file.`);
  if (info.size === 0) throw new Error(`Cannot upload ${path}: the file is empty.`);
  if (info.size > maxBytes) throw new Error(`Cannot upload ${path}: it is larger than this assignment's limit of ${maxBytes} bytes.`);
  return { path: real, name, size: info.size };
}
