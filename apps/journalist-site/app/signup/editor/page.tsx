import EditorSignup from "./editor-signup";

export default async function EditorSignupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const token = (await searchParams).token ?? "";
  return <main className="login">
    <p className="eyebrow">Invitation required</p>
    <h1>Create editor login</h1>
    <p>Your username and password sign-in is tied to the invited email and current newsroom access policy.</p>
    <EditorSignup token={token} />
  </main>;
}
