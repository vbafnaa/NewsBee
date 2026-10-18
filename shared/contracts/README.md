# Cross-project contracts

Home for versioned data contracts exchanged by the backend, reader website,
and review console. Examples of future contract areas are published editions,
stories with attribution, and review requests.

Keep one authoritative definition per contract. Contract format, validation,
and any code generation will be chosen before implementation. Do not add
parallel hand-maintained copies in each project.

Backend-only module interfaces belong in
`projects\backend\shared\contracts\`. HTTP-specific request and response concerns
belong in `projects\backend\api\schemas\`. This folder is not a general-purpose
shared code or UI library.
