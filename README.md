# CV Application Runner

A local LaTeX application workspace with a browser editor for CVs, motivation letters, portal texts and certificate bundles. The repository is a reusable starter. Its John Doe application is entirely fictional and exists to show a complete workflow.

The starter contains a two-page sample CV, a one-page motivation letter linked to its portal motivation field, a portal text sheet and three clearly marked certificate placeholder pages. Editable documents are JSON blocks under applications/. The Runner renders PDFs with LuaLaTeX and keeps generated files in ignored build/ and output/ folders.

## Requirements

- Git and Python 3.10 or newer.
- A TeX distribution with LuaLaTeX, latexmk, Source Sans 3, fontawesome5, pdfpages and the standard LaTeX packages used in src/common/cvmodern.sty. MiKTeX works on Windows; TeX Live works on macOS and Linux. Let the distribution install missing packages when prompted.
- An internet connection for the optional /code source editor. It loads Monaco, PDF.js, Split.js, icons and fonts from public CDNs. The main application block editor is served locally.

The bootstrap creates .venv and installs the Python PDF library. It checks the TeX tools and builds the sample; it reports what remains missing.

For a personal workspace, use GitHub's **Use this template** button to create a new **private** repository under your own account, then clone that new repository. This keeps your later CV changes away from the public starter. A plain clone of this starter keeps its public URL as origin. If you choose that route, rename the remote to upstream and add your own private origin before entering personal data.

## Clone and set up

Windows PowerShell:

    git clone https://github.com/timmwietheh-ux/cv-application-runner.git
    cd cv-application-runner
    python scripts/bootstrap.py
    pwsh -File scripts/editor/create-shortcut.ps1
    pwsh -File scripts/editor/start-background.ps1

If python opens a Microsoft Store prompt, run py -3 scripts/bootstrap.py instead. The generated LaTeX Runner CV Edition.lnk is local to this checkout and can be copied to the Desktop. It is not committed because it contains an absolute path.

macOS or Linux:

    git clone https://github.com/timmwietheh-ux/cv-application-runner.git
    cd cv-application-runner
    python3 scripts/bootstrap.py
    sh start.sh

On Windows, the launcher opens the Runner in your browser. It reuses this checkout's running server or chooses an available local port from 8053 through 8073, so another Runner can stay open. To see the chosen URL without opening a browser, run `pwsh -File scripts/editor/start-background.ps1 -NoBrowser`. On macOS or Linux, open http://127.0.0.1:8053/ after `sh start.sh`; if that port is occupied, pass another port, for example `sh start.sh 8054`. The server listens on this computer only. For an assistant-guided first run, copy the ready prompt in docs/START_WITH_AI.md into Codex or Claude Code while the clone is the active folder.

## Work in the Runner

1. Open the fictional example and explore Create. Its CV, letter and portal texts can be edited as blocks. Save a document, then build it for PDF preview.
2. Use New application to make an independent folder from a starter. The sample itself is not an applicant fact source.
3. Enter your own verified name and contact details in applications/profile.json. Put evidence and its source in .agents/memory/cv_facts.md. Record target requirements in the new application's target.md.
4. In Print & export, rebuild and download selected PDFs or export the portal text sheet. A combined PDF is useful for review; follow the real target's upload slots.
5. Place your private certificates in assets/attachments/certificates/ as degree.pdf, transcript.pdf and other.pdf. The certificate bundle replaces each blank page with every page of the matching PDF. Rename the entries in src/certificates/certificates.tex if your package needs different documents or ordering.

The certificate PDFs and generated documents are ignored by Git. Real data in applications/*.json, target.md and applications/profile.json is tracked unless you deliberately use a private repository or change the workflow. Never push a real application publicly without inspecting the exact staged files and obtaining the owner's approval.

## Command line and verification

    .venv\Scripts\python.exe scripts\cv.py list
    .venv\Scripts\python.exe scripts\cv.py check
    .venv\Scripts\python.exe scripts\cv.py build example-application
    .venv\Scripts\python.exe scripts\doctor.py --build

On macOS or Linux, replace .venv\Scripts\python.exe with .venv/bin/python. The doctor checks the sample PDF counts: CV 2, letter 1 and placeholders 3.

For development, install requirements-dev.txt and run:

    python -m pytest -q scripts/tests scripts/editor/tests
    node --test scripts/editor/tests/*.test.cjs

See docs/application-workflows.md for real application steps and AGENTS.md for assistant rules. The software is distributed under the MIT license.
