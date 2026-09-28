# Application workflow

1. Save the real call or job advert, its URL and the date checked in applications/<slug>/target.md and source-materials/.
2. Confirm the applicant's facts from original records or user statements. Put confirmed facts and provenance in .agents/memory/cv_facts.md. Put gaps in TODO.md.
3. Create a new application in the Runner or with scripts/cv.py new. Tailor its own CV, letter and portal JSON blocks. Do not edit generated TeX.
4. If a letter uses bodyFrom, edit the linked portal field, then rebuild both the portal sheet and the letter PDF.
5. Run python scripts/cv.py check and python scripts/cv.py build <slug>. Inspect every PDF page, text extraction, portal character count, upload size and target requirement.
6. In Print & export, choose and rebuild the exact registered PDFs in the desired order. Download the combined PDF only if the target accepts a combined file.
7. Keep certificate PDFs and outputs local. Review all files before a requested commit or push. Prefer a private repository for real applications.
