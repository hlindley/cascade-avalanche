# Shared Lab Knowledge setup — pending activation

This change installs task-start instructions only. The shared private registry has
not been published by this rollout; cloud settings and fresh-session acceptance
remain pending. Do not report successful access until an actual lookup succeeds.

Preserve the existing environment setup and maintenance commands. Once the registry
owner has supplied a verified private repository and full published commit, configure
LAB_KNOWLEDGE_REPOSITORY and LAB_KNOWLEDGE_COMMIT as ordinary environment settings.
Provide LAB_KNOWLEDGE_READ_TOKEN only as a setup/maintenance secret, restricted to
Contents: read on that single repository. If setup-only secrets are unsupported,
provision a read-only mount outside the agent session instead. Keep credentials
out of argv, Git remotes, files and logs. Never enable shell tracing around secrets.

Append this to both existing setup and maintenance hooks (Python 3.10+):

```sh
set +x
knowledge_status=0
python3 scripts/lab_knowledge_snapshot.py \
  --repository "$LAB_KNOWLEDGE_REPOSITORY" \
  --commit "$LAB_KNOWLEDGE_COMMIT" \
  --dest .knowledge || knowledge_status=$?
unset LAB_KNOWLEDGE_READ_TOKEN
case "$knowledge_status" in
  0) ;; # pinned snapshot obtained; graph age still comes from graph_updated_at
  3) printf '%s\n' 'Lab Knowledge: using verified cached/offline snapshot' ;;
  *) printf '%s\n' 'Lab Knowledge unavailable; report failed preflight' ;;
esac
```

These commands continue unrelated environment setup on registry failure; they do
not authorize unseen-donor-dependent decisions. Rebuild/reset setup caches after
changing the pin or hooks. For a shared mount, set LAB_KNOWLEDGE_ROOT in persistent
environment settings; an export in a separate setup shell is insufficient.

At task start, read `.knowledge/AGENTS.md` (or the configured mount policy), then:

```sh
python3 .knowledge/tools/radar.py preflight \
  --task "Describe the actual task and techniques" \
  --output .knowledge-receipts/UNIQUE-TASK-ID.json
```

Use a known registered project ID when appropriate; otherwise omit --project.
Read the best cards and complete the decision in the receipt. A no-match is valid.
If the CLI is itself absent, manually record lookup_status=unavailable and the
access error. Do not fabricate matches. Never claim a fresh remote lookup from a
cached snapshot. Record registry commit, graph SHA-256 and snapshot status. Inspect
receipts for private mappings before placing any content into a public PR.

Keep `.knowledge/`, `.knowledge.last-known/`, staging directories and full private
receipts out of Git and all app/public build artifacts. Knowledge lookup belongs
only in agent setup/workflow, never runtime game code. Token isolation, fresh-agent
instruction loading and real cloud access still need acceptance in this project's
actual environment. No equivalent global rule is assumed on other machines.
