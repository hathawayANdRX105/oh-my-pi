Glob files/dirs: `;`-separated paths or internal URLs (`local://*.md`, `omp://**/*.md`); default workspace root.
`gitignore` and `hidden` default true; ignored dotfiles need `gitignore: false`. Newest-first by directory; dirs end `/`.
{{#ifAny eagerDelegation hasFind hasCodegraph}}
{{#if hasFind}}Behavior search → `find`.{{/if}}
{{#if hasCodegraph}}Indexed source paths → `codegraph` `files`.{{/if}}
{{#if eagerDelegation}}Multi-round discovery → {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}.{{/if}}
{{/ifAny}}
