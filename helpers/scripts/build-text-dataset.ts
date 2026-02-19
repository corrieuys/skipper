import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type MessageRecord = {
    messages: Array<{
        role: "user" | "model";
        content: string;
    }>;
};

type FailedFile = {
    name: string;
    reason: string;
};

type InputEntry = {
    name: string;
    path: string;
    stat: ReturnType<typeof statSync> | undefined;
};

const DEFAULT_OUTPUT_NAME = "messages.dataset.jsonl";
const PROCESSED_DIR_NAME = "processed";

function printUsage(): void {
    console.error("Usage: bun run helpers/scripts/build-text-dataset.ts <directory>");
}

async function readExampleFile(filePath: string): Promise<MessageRecord> {
    const raw = await Bun.file(filePath).text();
    const normalized = raw.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");

    if (lines.length < 2) {
        throw new Error("missing model output after line 1");
    }

    const [firstLine, ...remainingLines] = lines;

    if (firstLine === undefined) {
        throw new Error("missing model output after line 1");
    }

    const userContent = firstLine.trim();
    const outputLines = remainingLines.map((line) => line.trim());

    // Ignore accidental whitespace-only lines around the output block.
    while (outputLines.length > 0 && outputLines[0] === "") {
        outputLines.shift();
    }
    while (outputLines.length > 0 && outputLines[outputLines.length - 1] === "") {
        outputLines.pop();
    }

    const modelContent = outputLines.join("\n");

    if (!userContent) {
        throw new Error("line 1 is empty");
    }

    if (!modelContent) {
        throw new Error("model output is empty");
    }

    return {
        messages: [
            { role: "user", content: userContent },
            { role: "model", content: modelContent },
        ],
    };
}

function validateJsonRecord(record: MessageRecord): void {
    const serialized = JSON.stringify(record);

    if (!serialized) {
        throw new Error("record could not be serialized to JSON");
    }

    JSON.parse(serialized);
}

async function main(): Promise<void> {
    const [inputPath] = process.argv.slice(2);

    if (!inputPath) {
        printUsage();
        process.exit(1);
    }

    const inputDirectory = resolve(inputPath);
    const inputDirectoryStat = statSync(inputDirectory, { throwIfNoEntry: false });

    if (!inputDirectoryStat?.isDirectory()) {
        console.error(`Input path is not a directory: ${inputDirectory}`);
        process.exit(1);
    }

    const outputPath = join(inputDirectory, DEFAULT_OUTPUT_NAME);
    const processedDirectory = join(inputDirectory, PROCESSED_DIR_NAME);
    const entries: InputEntry[] = readdirSync(inputDirectory)
        .filter((name) => !name.startsWith("."))
        .filter((name) => name !== basename(outputPath))
        .map((name) => ({
            name,
            path: join(inputDirectory, name),
            stat: statSync(join(inputDirectory, name), { throwIfNoEntry: false }),
        }))
        .filter((entry) => entry.stat?.isFile())
        .sort((left, right) => left.name.localeCompare(right.name));

    if (entries.length === 0) {
        console.error(`No regular files found in ${inputDirectory}`);
        process.exit(1);
    }

    const records: MessageRecord[] = [];
    const failedFiles: FailedFile[] = [];
    const successfulEntries: InputEntry[] = [];

    for (const entry of entries) {
        try {
            const record = await readExampleFile(entry.path);
            validateJsonRecord(record);
            records.push(record);
            successfulEntries.push(entry);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failedFiles.push({ name: entry.name, reason: message });
        }
    }

    if (records.length === 0) {
        console.error(`No valid examples found in ${inputDirectory}`);
        if (failedFiles.length > 0) {
            console.error("Failed input files:");
            for (const failedFile of failedFiles) {
                console.error(`- ${failedFile.name}: ${failedFile.reason}`);
            }
        }
        process.exit(1);
    }

    const output = records.map((record) => JSON.stringify(record)).join("\n");
    await Bun.write(outputPath, `${output}\n`);
    console.log(`Wrote ${records.length} examples to ${outputPath}`);

    if (successfulEntries.length > 0) {
        mkdirSync(processedDirectory, { recursive: true });
        for (const entry of successfulEntries) {
            const processedPath = join(processedDirectory, entry.name);
            rmSync(processedPath, { force: true });
            renameSync(entry.path, processedPath);
        }
        console.log(`Moved ${successfulEntries.length} processed files to ${processedDirectory}`);
    }

    if (failedFiles.length > 0) {
        console.error("Failed input files:");
        for (const failedFile of failedFiles) {
            console.error(`- ${failedFile.name}: ${failedFile.reason}`);
        }
    }
}

void main();
