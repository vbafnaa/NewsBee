# Local development commands

Home for future setup, run, replay, and maintenance commands for the local stack.
Keep product behavior in backend modules; scripts should invoke existing entry
points rather than duplicate pipeline logic.

`dev.py` provides `setup`, `up`, `stop`, `test`, `test-all`, `replay`, `browser`, `contracts`,
`ingest-events`, `events`, `evaluate-model`, and `author-edition` commands
using Python 3.13 on Windows, macOS, and Linux. See the root README for invocation
and prerequisites. The launcher owns only the processes it starts, supervises
their exits, and cleans them up on failure or shutdown. Stop uses a request file
rather than killing processes by name or trusting a saved PID.

`test` selects only critical offline checks; `test-all` restores the broader offline regression
suite. `replay` saves an offline Stage 1 gate report to `.local/stage-one-replay.xml` and can be
invoked by a local scheduler. `browser` selects the critical reader journeys.

`withdraw-story <edition id> --story <story id> --reason "<public explanation>"` delegates
to the backend's audited withdrawal module. It changes reader visibility, not original audit
evidence. IDs are displayed in the edition audit; reasons are public and append-only.
