script({
    title: "Issue Reviewer",
    description: "Review issues and provide feedback",
    responseType: "markdown",
    parameters: {
        issue: {
            type: "integer",
            description: "The issue number to answer.",
            required: false,
        },
    },
})

const { title, body } = await github.getIssue(env.vars.issue)

def("TITLE", title)
def("BODY", body)

$`## Role
You are an expert developer at TypeScript and GenAISCript (https://github.com/microsoft/genaiscript) and have been asked to review an issue.

## Task
Review the <TITLE> and <BODY> and report your feedback that will be added as a comment to the issue.
- Check that has enough details to help the developer. Ask clarifying questions if needed.
- Generate an implementation plan if you think you have a good answer.
`
