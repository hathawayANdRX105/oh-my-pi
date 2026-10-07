<system-reminder>
Your previous turn ended without calling task_complete, so the task is not confirmed finished{{#if reason}}. Last attempt ended with: {{reason}}{{/if}}.
{{unfinished}}Continue from where you left off and keep working on the remaining tasks. Call task_complete when the request is fully done, or when you need user input or are blocked.
(Reconnect {{attempt}}{{#if max}}/{{max}}{{/if}})
</system-reminder>
