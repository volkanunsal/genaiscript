import {
    Host,
    LogLevel,
    OAIToken,
    ReadFileOptions,
    UTF8Decoder,
    UTF8Encoder,
    defaultLog,
    dotCoarchPath,
    logWarn,
    setHost,
    tryReadJSON,
    writeJSON,
} from "coarch-core"
import { TextDecoder, TextEncoder } from "util"
import { readFile, writeFile } from "fs/promises"
import { ensureDir } from "fs-extra"
import { resolve, dirname } from "node:path"
import { glob } from "glob"

export class NodeHost implements Host {
    userState: any = {}

    static install() {
        setHost(new NodeHost())
    }

    async askToken(): Promise<string> {
        const path = dotCoarchPath("tmp/token.txt")
        logWarn(`reading token from ${path}`)
        return this.createUTF8Decoder().decode(await this.readFile(path))
    }
    async getSecretToken(): Promise<OAIToken> {
        return await tryReadJSON(dotCoarchPath("tmp/token.json"))
    }
    async setSecretToken(tok: OAIToken): Promise<void> {
        await writeJSON(dotCoarchPath("tmp/token.json"), tok)
    }
    log(level: LogLevel, msg: string): void {
        defaultLog(level, msg)
    }
    createUTF8Decoder(): UTF8Decoder {
        return new TextDecoder("utf-8")
    }
    createUTF8Encoder(): UTF8Encoder {
        return new TextEncoder()
    }
    projectFolder(): string {
        return resolve(".")
    }
    resolvePath(...segments: string[]) {
        return resolve(...segments)
    }
    async readFile(
        name: string,
        options?: ReadFileOptions
    ): Promise<Uint8Array> {
        return new Uint8Array(await readFile(name))
    }
    async findFiles(path: string): Promise<string[]> {
        const files = await glob(path)
        return files
    }
    async writeFile(name: string, content: Uint8Array): Promise<void> {
        await ensureDir(dirname(name))
        await writeFile(name, content)
    }
    async createDirectory(name: string): Promise<void> {
        await ensureDir(name)
    }
}
