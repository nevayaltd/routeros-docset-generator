# RouterOS Terraform Provider - Dash Docset Generator

This tool generates a Dash docset for the [Terraform RouterOS Provider](https://registry.terraform.io/providers/terraform-routeros/routeros/latest/docs) documentation.

## Prerequisites

- Node.js (v16 or higher)
- npm

## Installation

Install the required dependencies:

```bash
npm install
```

## Usage

Generate the docset:

```bash
npm run generate
```

Or directly:

```bash
node generate-docset.js
```

## What It Does

1. **Scrapes the documentation** from the Terraform Registry
2. **Extracts menu items** using the CSS selector `.menu-list-link a.ember-view`
3. **Downloads all documentation pages** locally
4. **Creates a SQLite search index** with proper categorization:
   - Resources → Resource type
   - Data Sources → Source type
   - Guides → Guide type
   - Functions → Function type
   - Provider config → Provider type
5. **Generates a complete `.docset`** bundle ready for Dash

## Output

The script creates a `RouterOS_Terraform.docset` directory with the following structure:

```
RouterOS_Terraform.docset/
├── Contents/
│   ├── Info.plist          # Docset metadata
│   └── Resources/
│       ├── docSet.dsidx    # SQLite search index
│       └── Documents/      # All downloaded HTML pages
```

## Installing in Dash

Once generated, you can install the docset in Dash:

1. Double-click `RouterOS_Terraform.docset`, or
2. Open Dash → Preferences → Docsets → + → Add Local Docset → select the `.docset` folder

## Customization

You can modify the script to:

- Change the `ENTRY_TYPES` mapping for different categorization
- Adjust the `determineEntryType()` function for better type detection
- Add filters to exclude certain pages
- Modify the downloaded HTML to remove navigation elements

## Troubleshooting

- **Timeout errors**: Increase the timeout in `page.goto()` calls
- **Missing pages**: Check the console output for download errors
- **Incorrect types**: Adjust the `determineEntryType()` function logic
- **Database errors**: Ensure the docset directory is writable

## License

MIT
