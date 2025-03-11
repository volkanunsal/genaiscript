// This file contains functions to manage and compile project scripts,
// including listing, creating, fixing, and compiling scripts.

import { buildProject } from "./build"
import { TYPESCRIPT_VERSION } from "./version"
import { copyPrompt } from "../../core/src/copy"
import {
    fixPromptDefinitions,
    createScript as coreCreateScript,
    fixCustomPrompts,
} from "../../core/src/scripts"
import { logInfo, logVerbose } from "../../core/src/util"
import { runtimeHost } from "../../core/src/host"
import { RUNTIME_ERROR_CODE } from "../../core/src/constants"
import {
    collectFolders,
    filterScripts,
    ScriptFilterOptions,
} from "../../core/src/ast"
import { deleteEmptyValues } from "../../core/src/cleaners"
import { dirname } from "node:path"

/**
 * Lists all the scripts in the project.
 * Displays id, title, group, filename, and system status.
 * Generates this list by first building the project.
 */
export async function listScripts(
    ids: string[],
    options?: ScriptFilterOptions
) {
    const prj = await buildProject() // Build the project to get script templates
    const scripts = filterScripts(prj.scripts, { ids, ...(options || {}) }) // Filter scripts based on options
    console.log(
        JSON.stringify(
            scripts.map(
                ({ id, title, group, filename, inputSchema, isSystem }) =>
                    deleteEmptyValues({
                        id,
                        title,
                        group,
                        filename,
                        inputSchema,
                        isSystem,
                    })
            ),
            null,
            2
        )
    )
}

/**
 * Creates a new script.
 * @param name - The name of the script to be created.
 * Calls core function to create a script and copies prompt definitions.
 * Compiles all scripts immediately after creation.
 */
export async function createScript(
    name: string,
    options: { typescript: boolean }
) {
    const { typescript } = options
    const t = coreCreateScript(name) // Call core function to create a script
    const pr = await copyPrompt(t, { fork: true, name, typescript }) // Copy prompt definitions
    console.log(`created script at ${pr}`) // Notify the location of the created script
    await compileScript([dirname(pr)]) // Compile all scripts immediately after creation
}

/**
 * Fixes prompt definitions in the project.
 * Used to correct any issues in the prompt definitions.
 * Accesses project information by building the project first.
 */
export async function fixScripts(options?: {
    githubCopilotPrompt?: boolean
    docs?: boolean
}) {
    const { githubCopilotPrompt, docs } = options || {}
    const project = await buildProject() // Build the project to access information
    await fixPromptDefinitions(project) // Fix any issues in prompt definitions
    await fixCustomPrompts(options)
}

/**
 * Compiles scripts in specified folders or all if none specified.
 * @param folders - An array of folder names to compile. Compiles all if empty.
 * Handles both JavaScript and TypeScript compilation based on folder content.
 * Exits process with error code if any compilation fails.
 */
export async function compileScript(folders: string[]) {
    const project = await buildProject() // Build the project to gather script information
    await fixPromptDefinitions(project) // Fix prompt definitions before compiling
    const scriptFolders = collectFolders(project) // Retrieve available script folders
    const foldersToCompile = (
        folders?.length ? folders : scriptFolders.map((f) => f.dirname)
    )
        .map((f) => scriptFolders.find((sf) => sf.dirname === f))
        .filter((f) => f)

    let errors = 0
    for (const folder of foldersToCompile) {
        const { dirname, js, ts } = folder
        if (js) {
            logInfo(`compiling ${dirname}/*.js`) // Log the start of JS compilation
            const res = await runtimeHost.exec(
                undefined,
                "npx",
                [
                    "--yes",
                    "--package",
                    `typescript@${TYPESCRIPT_VERSION}`,
                    "tsc",
                    "--project",
                    runtimeHost.path.resolve(dirname, "jsconfig.json"),
                ],
                {
                    cwd: dirname,
                }
            )
            if (res.stderr) logInfo(res.stderr) // Log any standard errors
            if (res.stdout) logVerbose(res.stdout) // Log verbose output if needed
            if (res.exitCode) errors++ // Increment error count if exit code indicates failure
        }
        if (ts) {
            logInfo(`compiling ${dirname}/*.{mjs,.mts}`) // Log the start of TypeScript compilation
            const res = await runtimeHost.exec(
                undefined,
                "npx",
                [
                    "--yes",
                    "--package",
                    `typescript@${TYPESCRIPT_VERSION}`,
                    "tsc",
                    "--project",
                    runtimeHost.path.resolve(dirname, "tsconfig.json"),
                ],
                {
                    cwd: dirname,
                }
            )
            if (res.stderr) logInfo(res.stderr) // Log any standard errors
            if (res.stdout) logVerbose(res.stdout) // Log verbose output if needed
            if (res.exitCode) errors++ // Increment error count if exit code indicates failure
        }
    }

    if (errors) process.exit(RUNTIME_ERROR_CODE) // Exit process with error code if any compilation failed
}
