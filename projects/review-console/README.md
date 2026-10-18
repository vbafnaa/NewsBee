# Local review console

Home for the minimal internal Stage 1 interface for editorial exceptions,
review decisions, audits, and corrections. Consume the local backend API;
publication checks and review state remain owned by backend editorial modules.

Cross-project contracts belong in `shared\contracts\` at the repository root.
UI code belongs within this project once its technology is confirmed.
This separate folder is a logical UI boundary, not a decision to require
another server, frontend framework, or independently deployed service.

Keep presentation lightweight and defer detailed UX design. This project is
not runnable yet.
