# First prompt for Codex or Claude Code

Copy the following prompt into a new chat after cloning this repository. It is written to work with either assistant. The assistant should work in the clone, not in the original public repository.

> I have created a private repository from https://github.com/timmwietheh-ux/cv-application-runner, or cloned that public starter into this folder. Please initialise it completely on this computer. Read AGENTS.md, README.md, the fact register and the setup scripts. Check Git status and remotes. If origin still points to the public starter, help me connect my own private repository before any personal content or push. Preserve existing work. Run the bootstrap and doctor; if Python, LuaLaTeX, latexmk or required TeX packages are missing, install them when possible or give me exact operating-system-specific steps, then rerun the checks. Build the fictional sample and verify that the CV has two pages, the motivation letter one page and the certificate placeholders three pages. Start the local Runner, open it in a real browser and check Create, save, PDF preview and Print & export. Create the local shortcut on Windows. Tell me what passed and what still needs installation. Do not invent my personal facts, do not copy John Doe claims into a real application, and do not publish my personal data. After the setup passes, ask me for my own records and the first real application target.

On Windows, the main command is:

    python scripts/bootstrap.py

If that command is captured by the Microsoft Store Python alias, try:

    py -3 scripts/bootstrap.py

On macOS or Linux:

    python3 scripts/bootstrap.py

The bootstrap creates a local .venv, installs the Python requirement and builds the sample. It does not install an operating-system TeX distribution for you. The assistant must verify that installation and explain any remaining step.

For a personal workspace, keep the clone private. The sample repository can be public; real CV JSON, profiles and dossiers may contain personal data and are tracked by Git unless you deliberately change that workflow.
