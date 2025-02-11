// Import necessary types and modules
import type { TextItem } from "pdfjs-dist/types/src/display/api"
import { host } from "./host"
import { TraceOptions } from "./trace"
import os from "os"
import { serializeError } from "./error"
import { dotGenaiscriptPath, logVerbose, logWarn } from "./util"
import { INVALID_FILENAME_REGEX, PDF_HASH_LENGTH, PDF_SCALE } from "./constants"
import { resolveGlobal } from "./globals"
import { isUint8Array, isUint8ClampedArray } from "util/types"
import { hash } from "./crypto"
import { join } from "path"
import { readFile, writeFile } from "fs/promises"
import { ensureDir } from "fs-extra"
import { YAMLStringify } from "./yaml"
import { deleteUndefinedValues } from "./cleaners"
import { CancellationOptions, checkCancelled } from "./cancellation"

let standardFontDataUrl: string

/**
 * Attempts to import pdfjs and configure worker source
 * based on the operating system.
 * @param options - Optional tracing options
 * @returns A promise resolving to the pdfjs module
 */
async function tryImportPdfjs(options?: TraceOptions) {
    const { trace } = options || {}
    installPromiseWithResolversShim() // Ensure Promise.withResolvers is available
    const pdfjs = await import("pdfjs-dist")
    let workerSrc = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs")

    // Adjust worker source path for Windows platform
    if (os.platform() === "win32")
        workerSrc = "file://" + workerSrc.replace(/\\/g, "/")

    standardFontDataUrl = workerSrc.replace(
        "build/pdf.worker.min.mjs",
        "standard_fonts"
    )

    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
    return pdfjs
}

class CanvasFactory {
    #enableHWA = false
    static createCanvas: (w: number, h: number) => any

    constructor() {}

    create(width: number, height: number) {
        if (width <= 0 || height <= 0) {
            throw new Error("Invalid canvas size")
        }
        const canvas = this._createCanvas(width, height)
        return {
            canvas,
            context: canvas.getContext("2d", {
                willReadFrequently: !this.#enableHWA,
            }),
        }
    }

    reset(canvasAndContext: any, width: number, height: number) {
        if (!canvasAndContext.canvas) {
            throw new Error("Canvas is not specified")
        }
        if (width <= 0 || height <= 0) {
            throw new Error("Invalid canvas size")
        }
        canvasAndContext.canvas.width = width
        canvasAndContext.canvas.height = height
    }

    destroy(canvasAndContext: any) {
        if (!canvasAndContext.canvas) {
            throw new Error("Canvas is not specified")
        }
        // Zeroing the width and height cause Firefox to release graphics
        // resources immediately, which can greatly reduce memory consumption.
        canvasAndContext.canvas.width = 0
        canvasAndContext.canvas.height = 0
        canvasAndContext.canvas = null
        canvasAndContext.context = null
    }

    /**
     * @ignore
     */
    _createCanvas(width: number, height: number) {
        return CanvasFactory.createCanvas(width, height)
    }
}

async function tryImportCanvas() {
    if (CanvasFactory.createCanvas) return CanvasFactory.createCanvas

    try {
        const skia = await import("skia-canvas")
        const createCanvas = (w: number, h: number) => new skia.Canvas(w, h)
        const glob = resolveGlobal()
        glob.ImageData ??= skia.ImageData
        glob.Path2D ??= skia.Path2D
        glob.Canvas ??= skia.Canvas
        glob.DOMMatrix ??= skia.DOMMatrix
        CanvasFactory.createCanvas = createCanvas
        return createCanvas
    } catch (error) {
        logWarn("Failed to import canvas")
        logVerbose(error)
        return undefined
    }
}

/**
 * Installs a shim for Promise.withResolvers if not available.
 */
function installPromiseWithResolversShim() {
    ;(Promise as any).withResolvers ||
        ((Promise as any).withResolvers = function () {
            let rs,
                rj,
                pm = new this((resolve: any, reject: any) => {
                    rs = resolve
                    rj = reject
                })
            return {
                resolve: rs,
                reject: rj,
                promise: pm,
            }
        })
}

enum ImageKind {
    GRAYSCALE_1BPP = 1,
    RGB_24BPP = 2,
    RGBA_32BPP = 3,
}

async function computeHashFolder(
    filename: string | WorkspaceFile,
    options: TraceOptions & ParsePDFOptions & { content?: Uint8Array }
) {
    const { trace, content, ...rest } = options
    const h = await hash(
        [typeof filename === "string" ? { filename } : filename, content, rest],
        {
            readWorkspaceFiles: true,
            version: true,
            length: PDF_HASH_LENGTH,
        }
    )
    return dotGenaiscriptPath("cache", "pdf", h)
}

/**
 * Parses PDF files using pdfjs-dist.
 * @param fileOrUrl - The file path or URL of the PDF
 * @param content - Optional PDF content as a Uint8Array
 * @param options - Options including disableCleanup and tracing
 * @returns An object indicating success or failure and the parsed pages
 */
async function PDFTryParse(
    fileOrUrl: string,
    content?: Uint8Array,
    options?: ParsePDFOptions & TraceOptions & CancellationOptions
) {
    const {
        cancellationToken,
        disableCleanup,
        trace,
        renderAsImage,
        scale = PDF_SCALE,
        cache,
    } = options || {}

    const folder = await computeHashFolder(fileOrUrl, {
        content,
        ...(options || {}),
    })
    const resFilename = join(folder, "res.json")
    const readCache = async () => {
        if (cache === false) return undefined
        try {
            const res = JSON.parse(
                await readFile(resFilename, {
                    encoding: "utf-8",
                })
            )
            logVerbose(`pdf: cache hit at ${folder}`)
            return res
        } catch {
            return undefined
        }
    }

    {
        // try cache hit
        const cached = await readCache()
        if (cached) return cached
    }

    logVerbose(`pdf: decoding ${fileOrUrl || ""} in ${folder}`)
    trace?.itemValue(`pdf: decoding ${fileOrUrl || ""}`, folder)
    await ensureDir(folder)
    try {
        const pdfjs = await tryImportPdfjs(options)
        const createCanvas = await tryImportCanvas()
        checkCancelled(cancellationToken)
        const { getDocument } = pdfjs
        const data = content || (await host.readFile(fileOrUrl))
        const loader = await getDocument({
            data,
            useSystemFonts: true,
            disableFontFace: true,
            standardFontDataUrl,
            CanvasFactory: createCanvas ? CanvasFactory : undefined,
        })
        const doc = await loader.promise
        const pdfMetadata = await doc.getMetadata()
        const metadata = pdfMetadata
            ? deleteUndefinedValues({
                  info: deleteUndefinedValues({
                      ...(pdfMetadata.info || {}),
                  }),
              })
            : undefined

        const numPages = doc.numPages
        const pages: PDFPage[] = []

        // Iterate through each page and extract text content
        for (let i = 0; i < numPages; i++) {
            checkCancelled(cancellationToken)
            const page = await doc.getPage(1 + i) // 1-indexed
            const content = await page.getTextContent()
            const items: TextItem[] = content.items.filter(
                (item): item is TextItem => "str" in item
            )
            let { lines } = parsePageItems(items)

            // Optionally clean up trailing spaces
            if (!disableCleanup)
                lines = lines.map((line) => line.replace(/[\t ]+$/g, ""))

            // Collapse trailing spaces
            const p: PDFPage = {
                index: i + 1,
                content: lines.join("\n"),
            }

            await writeFile(join(folder, `page_${p.index}.txt`), p.content)
            pages.push(p)

            if (createCanvas && renderAsImage) {
                const viewport = page.getViewport({ scale })
                const canvas = await createCanvas(
                    viewport.width,
                    viewport.height
                )
                const canvasContext = canvas.getContext("2d")
                const render = page.render({
                    canvasContext: canvasContext as any,
                    viewport,
                })
                await render.promise
                const buffer = canvas.toBufferSync("png")
                p.image = join(folder, `page_${i + 1}.png`)
                await writeFile(p.image, buffer)
            }

            const opList = await page.getOperatorList()
            const figures: PDFPageImage[] = []
            for (let j = 0; j < opList.fnArray.length; j++) {
                const fn = opList.fnArray[j]
                const args = opList.argsArray[j]
                if (fn === pdfjs.OPS.paintImageXObject && args) {
                    const imageObj = args[0]
                    if (imageObj) {
                        checkCancelled(cancellationToken)
                        const img = await new Promise<any>(
                            (resolve, reject) => {
                                if (page.commonObjs.has(imageObj))
                                    resolve(page.commonObjs.get(imageObj))
                                else if (page.objs.has(imageObj)) {
                                    page.objs.get(imageObj, (r: any) => {
                                        resolve(r)
                                    })
                                } else resolve(undefined)
                            }
                        )
                        if (!img) continue
                        const fig = await decodeImage(
                            p.index,
                            img,
                            createCanvas,
                            imageObj,
                            folder
                        )
                        if (fig) figures.push(fig)
                    }
                }
            }
            p.figures = figures

            logVerbose(
                `pdf: extracted ${fileOrUrl || ""} page ${i + 1} / ${numPages}, ${p.figures.length ? `${p.figures.length} figures` : ""}`
            )
        }

        const res = deleteUndefinedValues({
            ok: true,
            metadata,
            pages,
            content: PDFPagesToString(pages),
        })
        await writeFile(join(folder, "content.txt"), res.content)
        await writeFile(resFilename, JSON.stringify(res))
        return res
    } catch (error) {
        logVerbose(error)
        {
            // try cache hit
            const cached = await readCache()
            if (cached) return cached
        }
        trace?.error(`reading pdf`, error) // Log error if tracing is enabled
        await writeFile(
            join(folder, "error.txt"),
            YAMLStringify(serializeError(error))
        )
        return { ok: false, error: serializeError(error) }
    }

    async function decodeImage(
        pageIndex: number,
        img: {
            data: Uint8Array | Uint8ClampedArray
            width: number
            height: number
            kind: ImageKind
        },
        createCanvas: (w: number, h: number) => any,
        imageObj: any,
        folder: string
    ) {
        if (!isUint8ClampedArray(img?.data) && !isUint8Array(img?.data))
            return undefined

        const { width, height, data: _data, kind } = img
        const imageData = new ImageData(width, height)
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const dstIdx = (y * width + x) * 4
                imageData.data[dstIdx + 3] = 255 // A
                if (kind === ImageKind.GRAYSCALE_1BPP) {
                    const srcIdx = y * width + x
                    imageData.data[dstIdx + 0] = _data[srcIdx] // B
                    imageData.data[dstIdx + 1] = _data[srcIdx] // G
                    imageData.data[dstIdx + 2] = _data[srcIdx] // R
                } else {
                    const srcIdx =
                        (y * width + x) *
                        (kind === ImageKind.RGBA_32BPP ? 4 : 3)
                    imageData.data[dstIdx + 0] = _data[srcIdx] // B
                    imageData.data[dstIdx + 1] = _data[srcIdx + 1] // G
                    imageData.data[dstIdx + 2] = _data[srcIdx + 2] // R
                }
            }
        }
        const canvas = await createCanvas(width, height)
        const ctx = canvas.getContext("2d")
        ctx.putImageData(imageData, 0, 0)
        const buffer = canvas.toBufferSync("png")
        const fn = join(
            folder,
            `page-${pageIndex}-${imageObj.replace(INVALID_FILENAME_REGEX, "")}.png`
        )
        await writeFile(fn, buffer)

        return {
            id: imageObj,
            width,
            height,
            type: "image/png",
            size: buffer.length,
            filename: fn,
        } satisfies PDFPageImage
    }
}

/**
 * Joins pages into a single string with page breaks.
 * @param pages - Array of page content strings
 * @returns A single string representing the entire document
 */
function PDFPagesToString(pages: PDFPage[]) {
    return pages
        ?.map((p) => `-------- Page ${p.index} --------\n\n${p.content}`)
        .join("\n\n")
}

/**
 * Parses a PDF file and applies optional filtering.
 * @param filename - The PDF file path
 * @param options - Options including filtering and tracing
 * @returns A promise resolving to the parsed pages and concatenated content
 */
export async function parsePdf(
    filenameOrBuffer: string | Uint8Array,
    options?: ParsePDFOptions & TraceOptions & CancellationOptions
): Promise<{
    pages: PDFPage[]
    content: string
    metadata?: Record<string, any>
}> {
    const filename =
        typeof filenameOrBuffer === "string" ? filenameOrBuffer : undefined
    const bytes =
        typeof filenameOrBuffer === "string"
            ? undefined
            : (filenameOrBuffer as Uint8Array)
    const { pages, ok, metadata, content } = await PDFTryParse(
        filename,
        bytes,
        options
    )
    if (!ok) return { pages: [], content: "" }
    return { pages, content, metadata }
}

/**
 * Parses text items from a PDF page into lines.
 * @param pdfItems - Array of text items
 * @returns An object containing parsed lines
 */
function parsePageItems(pdfItems: TextItem[]) {
    const lineData: { [y: number]: TextItem[] } = {}

    // Group text items by their vertical position (y-coordinate)
    for (let i = 0; i < pdfItems.length; i++) {
        const item = pdfItems[i]
        const y = item?.transform[5]
        if (!lineData.hasOwnProperty(y)) {
            lineData[y] = []
        }
        // Ensure the item is valid before adding
        /* istanbul ignore next */
        if (item) {
            lineData[y]?.push(item)
        }
    }

    const yCoords = Object.keys(lineData)
        .map((key) => Number(key))
        // Sort by descending y-coordinate
        .sort((a, b) => b - a)
        // Insert empty lines based on line height differences
        .reduce((accum: number[], currentY, index, array) => {
            const nextY = array[index + 1]
            if (nextY != undefined) {
                const currentLine = lineData[currentY]!
                const currentLineHeight: number = currentLine.reduce(
                    (finalValue, current) =>
                        finalValue > current.height
                            ? finalValue
                            : current.height,
                    -1
                )

                // Check if a new line is needed based on height
                if (Math.floor((currentY - nextY) / currentLineHeight) > 1) {
                    const newY = currentY - currentLineHeight
                    lineData[newY] = []
                    return accum.concat(currentY, newY)
                }
            }
            return accum.concat(currentY)
        }, [])

    const lines: string[] = []
    for (let i = 0; i < yCoords.length; i++) {
        const y = yCoords[i]
        // Ensure y-coordinate is defined
        /* istanbul ignore next */
        if (y == undefined) {
            continue
        }
        // Sort by x position within each line
        const lineItems = lineData[y]!.sort(
            (a, b) => a.transform[4] - b.transform[4]
        ).filter((item) => !!item.str)
        const firstLineItem = lineItems[0]!
        let line = lineItems.length ? firstLineItem.str : ""

        // Concatenate text items into a single line
        for (let j = 1; j < lineItems.length; j++) {
            const item = lineItems[j]!
            const lastItem = lineItems[j - 1]!
            const xDiff =
                item.transform[4] - (lastItem.transform[4] + lastItem.width)

            // Insert spaces for horizontally distant items
            /* istanbul ignore next */
            if (
                item.height !== 0 &&
                lastItem.height !== 0 &&
                (xDiff > item.height || xDiff > lastItem.height)
            ) {
                const spaceCountA = Math.ceil(xDiff / item.height)
                let spaceCount = spaceCountA
                if (lastItem.height !== item.height) {
                    const spaceCountB = Math.ceil(xDiff / lastItem.height)
                    spaceCount =
                        spaceCountA > spaceCountB ? spaceCountA : spaceCountB
                }
                line += Array(spaceCount).fill("").join(" ")
            }
            line += item.str
        }
        lines.push(line)
    }

    return {
        lines,
    }
}
