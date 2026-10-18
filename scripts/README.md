# Local development commands

Home for future setup, run, replay, and maintenance commands for the local stack.
Keep product behavior in backend modules; scripts should invoke existing entry
points rather than duplicate pipeline logic.

`dev.py` provides `setup`, `up`, `stop`, `test`, `browser`, `contracts`,
`ingest-events`, and `events` commands
using Python 3.13 on Windows, macOS, and Linux. See the root README for invocation
and prerequisites. The launcher owns only the processes it starts, supervises
their exits, and cleans them up on failure or shutdown. Stop uses a request file
rather than killing processes by name or trusting a saved PID.
