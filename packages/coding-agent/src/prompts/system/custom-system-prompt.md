{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
{{customPrompt}}
{{#if appendPrompt}}
{{appendPrompt}}
{{/if}}
{{#ifAny contextFiles.length git.isRepo}}
<project>
{{#if contextFiles.length}}
## Context
<instructions>
{{#list contextFiles join="\n"}}
<file path="{{path}}"{{#if frontmatter.type}} type="{{frontmatter.type}}"{{/if}}{{#if frontmatter.tags}} tags="{{frontmatter.tags}}"{{/if}}{{#if frontmatter.status}} status="{{frontmatter.status}}"{{/if}}{{#if frontmatter.milestone}} milestone="{{frontmatter.milestone}}"{{/if}}{{#if frontmatter.validation}} validation="{{frontmatter.validation}}"{{/if}}{{#if frontmatter.decision_level}} decision_level="{{frontmatter.decision_level}}"{{/if}}>
{{content}}
</file>
{{/list}}
</instructions>

{{#ifAll hasOkfContext contextFiles.length}}
## OKF Knowledge Wiki
<okf-wiki-protocol>
OKF context is an indexable knowledge wiki, not bulk background.
- For product, architecture, hardware, safety, runtime, algorithm, milestone, or owner-boundary questions, start from the nearest loaded `index.md` gateway and read only the relevant linked concept files.
- Route by concept type first: `FreezeDecision` = V1/scope/milestone; `SystemDesign`/`ArchitectureConcept` = architecture/ownership; `RuntimeConstraint` = timing/bus/runtime limits; `SafetyConcept` = safety; `HardwareBinding` = hardware; `CodegenContract` = schemas/contracts; `Playbook` = procedures; `Reference` = background.
- Treat status/decision/validation as binding when present in the concept, index, or manifest: `frozen-v1` outranks lower-level docs; `open-question` is not settled; `deprecated` is background only; never upgrade `x64-only` or `simulator-validated` to hardware evidence; `needs-*` means state the owner decision boundary.
- Prefer exact index/metadata lookup before semantic search. Use `semble_search` scoped to `product_doc/` only when names/tags do not locate the concept.
- For decision-bearing product facts, cite the concept file path(s). When editing OKF docs, update the nearest index/log and run `python3 scripts/validate_okf_wiki.py --root . --strict-tags`.
</okf-wiki-protocol>
{{/ifAll}}
{{/if}}
{{#if git.isRepo}}
## Version Control
Snapshot; does not update during conversation.
Current branch: {{git.currentBranch}}
Main branch: {{git.mainBranch}}
{{git.status}}
### History
{{git.commits}}
{{/if}}
</project>
{{/ifAny}}
{{#if skills.length}}
Skills are specialized knowledge. Scan descriptions for your task domain.
If a skill applies, you MUST read `skill://<name>` before proceeding.
<skills>
{{#list skills join="\n"}}
<skill name="{{name}}">
{{description}}
</skill>
{{/list}}
</skills>
{{/if}}
{{#if alwaysApplyRules.length}}
{{#each alwaysApplyRules}}
{{content}}
{{/each}}
{{/if}}
{{#if rules.length}}
Rules are local constraints. You MUST read `rule://<name>` when working in that domain.
<rules>
{{#list rules join="\n"}}
<rule name="{{name}}">
{{description}}
{{#if globs.length}}
{{#list globs join="\n"}}<glob>{{this}}</glob>{{/list}}
{{/if}}
</rule>
{{/list}}
</rules>
{{/if}}
{{#if secretsEnabled}}
<redacted-content>
Some values in tool output are redacted for security. They appear as `#XXXX#` tokens (4 uppercase-alphanumeric characters wrapped in `#`). These are **not errors** — they are intentional placeholders for sensitive values (API keys, passwords, tokens). Treat them as opaque strings. NEVER attempt to decode, fix, or report them as problems.
</redacted-content>
{{/if}}
