# Agent instructions: CV Application Runner

This repository is a public, fictional starter. Read these instructions before editing. The current user's instructions take priority.

## First run

1. Check Git status. Preserve changes whose origin you do not know.
2. Read README.md, docs/START_WITH_AI.md, .agents/memory/cv_facts.md and TODO.md.
3. Run python scripts/bootstrap.py. If a prerequisite is missing, give the user exact installation steps for their operating system, then rerun the doctor and sample build.
4. Verify the example CV has two pages, its letter one page and its certificate placeholder PDF three pages. Open the local Runner and check the example in Create and Print & export.
5. Ask for the user's own facts and target material before drafting a real application.

## Facts and privacy

John Doe, Example Organisation, Sample University, every sample role and every sample result are fictional. They demonstrate layout only. Never treat them as the user's history or submit them. Never invent education, grades, work, results, dates, awards, skills, language levels, contact details or referees. Record facts with provenance in .agents/memory/cv_facts.md. Put unverified items in TODO.md and keep them out of submission text.

The starter Git history contains no personal certificates. The directory assets/attachments/certificates/ is ignored except for .gitkeep. Keep real certificates and generated build/ and output/ files out of Git. Application JSON, dossiers and profiles are tracked by default, so use a private repository or review and exclude personal data before any public push. Never commit or push personal application material without the user's explicit request and a review of the staged files. Do not copy private portal HTML, passwords, tokens or unrelated files into packages.

## Editing

- applications/profile.json owns shared identity and contact lines.
- applications/<slug>/application.json owns the document register, output names and checklist.
- Adjacent JSON files are the editable source of CV, letter and portal text blocks.
- A letter with bodyFrom takes its body from a portal field. Edit that field once and rebuild both outputs.
- src/common/cvmodern.sty owns the common layout.
- src/certificates/certificates.tex includes private certificate PDFs by filename or displays clearly marked blank pages.
- Never edit generated TeX under build/ or PDFs under output/ as source.
- Use the reusable guidance in .claude/skills/application-workspace/SKILL.md.

Write clear, truthful application prose. Match exact prompts, deadlines and limits from the current official target. Keep factual claims within their verified scope. The sample is for testing only.

## Checks

Run python scripts/cv.py check, then build the touched documents. For reusable changes run python scripts/doctor.py --build and the Python and Node tests. Inspect page counts, extracted text and rendered page images. After UI or server changes, test in a real browser. Run git diff --check before handoff. Append a concise entry to .agents/memory/change_log.md after meaningful changes.
