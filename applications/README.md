# Applications

Each application lives in its own folder. Its application.json registers the documents shown by the Runner. Adjacent JSON files contain editable CV, letter and portal text blocks. target.md records the real source, requirements and open questions. The _templates folder supplies starters.

The example-application folder is fictional and intentionally complete for testing. Its letter reads the motivation field in portal.json through bodyFrom. Keep this pattern when one message is needed both as portal text and as a PDF letter.

Shared contact details live in profile.json. Build products appear under build/ and output/ and are ignored by Git. Private certificates belong in assets/attachments/certificates/ and are ignored too.

Create a separate application with the New application button or with the command line:

    python scripts/cv.py new my-application --title "My application" --category general --cv template:academic-cv --letter template:motivation-letter --texts template:portal-texts

The new template has visible TODO markers. Fill those from your verified fact register, then run check and build.
