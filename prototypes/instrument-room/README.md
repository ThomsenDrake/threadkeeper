# Instrument room prototype

Standalone design prototype for the Threadkeeper profile. It is not part of the production web app, API, worker, or MCP server.

Open it with any static file server from this directory:

```sh
python3 -m http.server 4173
```

Then visit `http://127.0.0.1:4173/`. Every person, project, agent, and memory belongs to the synthetic profile **Iris Calder**. Corrections, forgetting, and Inquiry answers run only in the page. Nothing is saved, and no model is called.

Inquiry answers are labelled **Simulated**. The five suggested questions use fixed citations so the demonstration stays specific. Other questions use a small in-page word match over the synthetic Record. A forgotten memory drops out of later answers.

Every current memory is delivered automatically to the agents. Origin labels describe where a memory came from. The profile supports inspection, correction and forgetting.

The circular **T** mark is an exploratory monogram for this study. It is not a House Augustus sigil, and the interface does not rename Threadkeeper.
