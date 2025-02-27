system({ title: "YAML output" })
export default function (ctx: PromptContext) {
    const { $ } = ctx
    $`## YAML output
Respond in YAML. Use valid yaml syntax for fields and arrays! No yapping, no markdown, no code fences, no XML tags, no string delimiters wrapping it.
`
}
