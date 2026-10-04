# Threadkeeper

**Switch agents. Keep the thread.**

Threadkeeper is one personal memory shared by the chatbots and coding agents you already use. Tell one assistant about your project deadline or how you like things written, and the next assistant can recall it, without you repeating yourself and without the two ever seeing each other's conversations.

You stay in charge of that memory. You can read everything that is remembered, see where each item came from, fix anything that is wrong, and forget anything you no longer want kept. Nothing an assistant guesses about you becomes memory until you approve it.

> **Early preview.** Threadkeeper is in private development and runs on your own computer or server. It is not yet published or available as a hosted service, and its open-source license has not been chosen yet.

![Your memory profile, with search and filters](docs/images/memories.png)

<sub>Screenshots use an example profile with made-up data: a writer named Maya, her project Harbor Notes, and two connected assistants.</sub>

## What you can do

### See everything that is remembered

Your profile lists every memory in one place, and you can add your own with **Add memory**. Search it, or filter by subject, project, where it came from, or status. Each memory shows what kind it is (a preference, a decision, a fact) and whether you said it yourself or an assistant reported it.

The profile works on a phone, too.

<img src="docs/images/memories-phone.png" alt="The same profile on a phone-sized screen" width="390">

### Fix it in one step

Open any memory to see the exact words it came from and every change made to it. When you correct something, your correction takes effect immediately. There is no approval step. The original wording is kept alongside it, so you can always see what changed and why.

![A corrected launch date, shown with the original note and the correction](docs/images/memory-detail.png)

### Approve guesses before they count

Sometimes an assistant suggests something it thinks you would want remembered, like "Maya prefers to draft in the morning." Those suggestions wait in **Needs review**, and they stay out of what assistants recall until you decide. You can confirm a suggestion, edit it first, or dismiss it. Ignoring a suggestion never counts as approval.

![A suggested memory waiting for you to confirm, edit, or dismiss](docs/images/needs-review.png)

### Decide what each assistant can do

Each assistant gets its own credential, a private access key that only it uses. For each one, you choose whether it can only read your memory or also save new things to it, and which projects it can see. Personal memories that are not tied to a project are visible to every assistant you connect. You can pause saving for every assistant at once, or revoke one assistant's access at any time.

Connecting an assistant does not give Threadkeeper your chat history. An assistant only saves what it explicitly sends, under the permissions you gave it.

![Saving controls, the connection address, and two assistants with different permissions](docs/images/connections.png)

### Check what was saved

**Captures** shows everything assistants have sent and what happened to it. Notes saved directly appear right away. Material sent for the AI model to turn into suggested memories waits its turn, and if that step fails, you can see it and try again. The original text is always kept.

![Saved, waiting, and failed captures, with a retry button](docs/images/captures.png)

### Take your memory with you

Download your whole memory as a single file: what was said, what is remembered, and every correction. Credentials are never included. You can import that file into another Threadkeeper installation.

If you restore an older backup, a separate deletion record makes sure things you already forgot do not come back.

![Export, import, and the deletion record](docs/images/portability.png)

## Get started

Threadkeeper runs on your own machine or server. You pick where data is stored, which AI model it uses, and who can sign in. You never need a Threadkeeper account. Run the commands in this section from a copy of this repository.

### Try the demo

To look around before setting anything up, run the demo. It needs [Node.js 24](https://nodejs.org/) and [pnpm](https://pnpm.io/):

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev:demo
```

Open `http://127.0.0.1:3000` and sign in with `demo@example.invalid` and the password `threadkeeper-demo-password`. The demo uses a temporary database, does not call an AI model, and erases everything when you stop it.

### Install it for real

For a setup that keeps your data, use [Docker](https://docs.docker.com/get-docker/) with Compose 2.24.4 or newer. This starts the profile, the connection service, the background processor, and the database together.

1. Copy the example settings file:

   ```sh
   cp .env.example .env
   ```

2. Open `.env` and fill in:
   - `POSTGRES_PASSWORD`: a database password. Use only letters, numbers, `-`, `_`, `.`, and `~`.
   - `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD`: the email and password you will sign in with. The password needs at least 12 characters.
   - `NEBIUS_API_KEY` (optional): a key for the preset AI model, described in [How memories are made](#how-memories-are-made). Without it, notes that assistants save directly still work, but suggestions cannot be generated.

   Keep `.env` private. It contains your passwords.

3. Start Threadkeeper:

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml up --build
   ```

4. Open `http://localhost:3000` and sign in with the email and password from step 2.

Your data is stored in a Docker volume and survives restarts. Threadkeeper only accepts connections from the same machine. Your sign-in password is set the first time Threadkeeper starts; changing `BOOTSTRAP_PASSWORD` afterwards does not change it.

Search works out of the box. For recall that also matches by meaning rather than exact words, see [retrieval setup](docs/RETRIEVAL.md). For backups and restores, see [portability and operations](docs/PORTABILITY.md).

## Connect an assistant

Threadkeeper connects to assistants through [MCP](https://modelcontextprotocol.io/), an open standard many chatbots and coding agents support.

1. Sign in and open **Connections**.
2. Select **Create credential**, name it after the assistant, and choose whether it may save and which projects it may see.
3. Copy the token right away. It is only shown once.
4. Copy the MCP address. On your own machine it looks like `http://127.0.0.1:3000/mcp`.
5. In the assistant's settings, add a remote MCP server with that address, and send the token as a bearer token in the `Authorization` header.
6. Ask the assistant to check Threadkeeper when your context would change its answer, and to save only lasting facts, preferences, decisions, and corrections you want kept.

The assistant needs to support remote MCP over Streamable HTTP and custom headers. Some assistants do not support custom headers yet and cannot connect. Step-by-step setup for Codex, and the full list of what an assistant can ask Threadkeeper to do, are in the [client guide](docs/CLIENTS.md).

Here is what that looks like with two assistants. Your writing assistant saves a deadline and a style preference. Later, your coding agent recalls both. You then correct the deadline and forget the preference in your profile. The next time either assistant asks, it gets the corrected deadline and no preference.

## Privacy and control

**Every memory shows its source.** Each memory links to the exact text it came from. Things you said, things an assistant reported, and things an assistant suggested are always labeled differently.

**Your edits win.** A correction you make is the current version as soon as you save it.

**Forgetting is thorough.** Before anything is removed, Threadkeeper shows you exactly what will go: the memory, the text it came from, its history, and any processing still waiting. Once you confirm, all of it is removed from your installation and from future recall. Forgetting a memory also removes the note it came from and anything else drawn from that note, so save separate facts as separate notes if you might want to forget just one.

Threadkeeper cannot reach back into copies that already left it. If an assistant already received a memory, or you already downloaded an export, that copy is outside Threadkeeper's control.

## How memories are made

When an assistant sends longer material, a background processor uses an AI model to suggest memories from it. Each suggestion still waits for your review.

The preset model is `nvidia/Nemotron-3_5-Lightning`, served by Nebius at `https://api.tokenfactory.nebius.com/v1/`. You can point Threadkeeper at any OpenAI-compatible model server instead, including one you run yourself, by setting `MODEL_BASE_URL` and `MODEL_ID` in `.env`.

## Learn more

- [Client guide](docs/CLIENTS.md): connecting assistants, and what they can save and recall
- [Retrieval setup](docs/RETRIEVAL.md): meaning-based recall with an embedding service
- [Portability and operations](docs/PORTABILITY.md): export format, import rules, backup, and restore
- [Development guide](docs/DEVELOPMENT.md): running from source, project status, and contributing

Threadkeeper is planned to live at `threadkeep.si`. Demos and tests use made-up data only, so please keep real conversations and credentials out of issues and pull requests.
