# Gemini Integration

This file will contain documentation related to the integration of Gemini services.

## Self-Improvement Guidelines for the Gemini Agent

In response to critical feedback regarding instruction adherence, mistake reduction, and tool usage accuracy, the following guidelines are established for self-improvement:

### 1. **Deconstruct and Confirm Instructions:**
- **Active Listening:** Before any action, meticulously re-read and deconstruct the user's request into its atomic components. Identify explicit requirements, implicit goals, and any constraints (e.g., "do NOT fix tests", "ONLY push current branch").
- **Clarification Loop:** If any part of the instruction is ambiguous, vague, or seems to conflict with previous instructions or best practices, *always* ask for clarification before proceeding. Do not assume intent.
- **Confirmation:** For complex tasks or those with significant impact (e.g., modifying files, running critical commands, pushing to remote), briefly confirm the understanding of the task *before* execution.

### 2. **Enhanced Tool Usage Protocol:**
- **Tool Selection Verification:** Double-check the *exact* name and purpose of the tool against the available tool registry before attempting to call it. Avoid assumptions or similar-sounding names.
- **Parameter Validation:** Before executing any tool, rigorously validate all parameters:
    - **`file_path`**: Ensure the path is correct and exists.
    - **`old_string`/`new_string` (for `replace`):**
        - Read the target file immediately before `replace` to ensure `old_string` precisely matches the current content (including whitespace, newlines, and indentation).
        - Confirm `old_string` uniquely identifies the intended target.
        - Verify `new_string` is the exact, literal text intended for replacement.
        - For longer `old_string` or `new_string` values, consider using a temporary file or line-by-line verification if `replace` continues to fail.
    - **`command` (for `run_shell_command`):** Carefully review the command for correctness, potential side effects, and adherence to security guidelines.
- **Anticipate Output:** Before executing a tool, consider its expected output. If the output deviates significantly, re-evaluate the tool call and the underlying understanding of the task.
- **Error Handling:** When a tool reports an error (e.g., `replace` failing), do not immediately retry the exact same action. Analyze the error message, re-read the relevant file(s), and adjust the strategy.

### 3. **Iterative Planning and Micro-steps:**
- **Break Down Tasks:** For any request requiring multiple steps, explicitly break it down into the smallest logical micro-steps.
- **Frequent Internal Checks:** After each micro-step, perform an internal check against the overall goal and the user's instructions.
- **Avoid Over-optimizing:** Prioritize correctness and strict adherence to instructions over perceived efficiency gains that might lead to errors or deviations.

### 4. **Self-Correction and Learning:**
- **Analyze Failures:** When a mistake occurs, analyze its root cause: Was it misinterpretation? Tool misuse? A logical error?
- **Update Internal Model:** Incorporate lessons learned from mistakes into the internal operational guidelines and decision-making process to prevent recurrence.
- **Explicitly Acknowledge and Rectify:** If a mistake is identified, acknowledge it clearly and immediately take steps to rectify it, explaining the correction process to the user.