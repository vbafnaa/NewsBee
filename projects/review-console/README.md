# Local review console

Home for the minimal internal Stage 1 interface for editorial exceptions,
review decisions, audits, and corrections. Consume the local backend API;
publication checks and review state remain owned by backend editorial modules.

Cross-project contracts belong in `shared\contracts\` at the repository root.
Jinja renders `templates\index.html` through the backend's `/review` route.
`static\health.js` fetches the same health API other clients use. This separate
folder is a logical UI boundary, not another server or independently deployed
service. No frontend build step is needed.

Keep presentation lightweight and defer detailed UX design. This project is
served by the local backend; see the root README. Only the health view is
implemented, not editorial review actions.
