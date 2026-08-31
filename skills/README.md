# Agent skills

Installable [agent skills](https://agentskills.io) for archonum — the same
content served at <https://app.archonum.com/skill.md>, packaged in the standard
`skills/<name>/SKILL.md` layout so agents that cannot fetch web pages can still
install it.

| Skill | What it teaches an agent |
| --- | --- |
| [`archonum`](archonum/SKILL.md) | Set up and use the archonum remote stealth browser over MCP: when to prefer it over `web_fetch`, authentication, the tool set, limits, troubleshooting. |

## Install

With the [skills CLI](https://skills.sh):

```bash
npx skills add papers-ch/archonum-sdk-js
```

Or manually — copy the skill folder into your agent's skills directory, e.g.
for Claude Code:

```bash
cp -r skills/archonum ~/.claude/skills/
```

## Keeping in sync

The body of `archonum/SKILL.md` (everything below the frontmatter) mirrors
<https://app.archonum.com/skill.md>. When the hosted skill changes, re-copy the
body here; the frontmatter block at the top is repo-only.
