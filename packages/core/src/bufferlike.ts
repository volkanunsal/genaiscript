import { resolveFileBytes } from "./file"
import { TraceOptions } from "./trace"
import { fileTypeFromBuffer } from "file-type"

export async function resolveBufferLike(
    bufferLike: BufferLike,
    options?: TraceOptions
): Promise<Buffer> {
    // If the URL is a string, resolve it to a data URI
    if (typeof bufferLike === "string")
        return Buffer.from(await resolveFileBytes(bufferLike, options))
    else if (bufferLike instanceof Blob)
        return Buffer.from(await bufferLike.arrayBuffer())
    else if (bufferLike instanceof ReadableStream) {
        const stream: ReadableStream = bufferLike
        return Buffer.from(await new Response(stream).arrayBuffer())
    } else if (bufferLike instanceof ArrayBuffer)
        bufferLike = Buffer.from(bufferLike)
    else if (
        typeof bufferLike === "object" &&
        (bufferLike as WorkspaceFile).content
    )
        return Buffer.from(
            (bufferLike as WorkspaceFile).content,
            (bufferLike as WorkspaceFile).encoding || "utf-8"
        )
    throw new Error("Unsupported buffer-like object")
}

export async function BufferToBlob(buffer: Buffer | Uint8Array) {
    const mime = await fileTypeFromBuffer(buffer)
    return new Blob([buffer], {
        type: mime?.mime || "application/octet-stream",
    })
}
