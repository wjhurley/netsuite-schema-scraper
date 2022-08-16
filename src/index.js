const fsExtra = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');

function capitalizeWord(word) {
    return word[0].toUpperCase() + word.slice(1);
}

function createEnum(leftDrawerLink, fileName, rows) {
    let fileContent =
        `// ${leftDrawerLink}
export enum ${fileName} {`;

    // Remove 'Value' row
    rows.shift();

    for (const row of rows) {
        const strippedKey = row.replace(/[_-]/g, '');
        const capitalizedKey = capitalizeWord(strippedKey);

        // Space in template literal below is intentional
        fileContent += `
    ${capitalizedKey} = '${row}',`;
    }

    fileContent += `
}
`;

    return fileContent;
}
// TODO: Create a similar function to create the `filePath.js` object/file, or extend this to handle both
async function createFilePathEnum(relativeFilePath, fileName, filePaths) {
    const outputPath = path.resolve(__dirname, relativeFilePath);
    const outputFile = `${outputPath}/${fileName}.ts`;

    // Check if file already exists before we go any further
    const doesFileAlreadyExist = await fsExtra.pathExists(outputFile);

    if (doesFileAlreadyExist) {
        console.log(`FilePath enum already exists at ${outputFile}, skipping.`);
        return;
    }

    const sortedFilePathArray = Object.entries(filePaths)
        .sort(([keyA, valueA], [keyB, valueB]) => valueA.localeCompare(valueB));
    let previousParentFolder = '';

        let fileContent =
`export enum ${fileName} {`;

    for (const [fileName, filePath] of sortedFilePathArray) {
        const parentFolderIndex = filePath.lastIndexOf('/');
        const parentFolder = filePath.slice(0, parentFolderIndex + 1);

        // Add a new line in between enum entries for different parent folders
        const newLineOrEmptyString = previousParentFolder !== '' && previousParentFolder !== parentFolder
            ? '\n'
            : '';

        fileContent += `
${newLineOrEmptyString}    ${fileName} = '${filePath}',`;
        previousParentFolder = parentFolder;
    }

    fileContent += `
}
`;

    // Ensure file path exists before we try writing the file
    await fsExtra.ensureDir(outputPath);
    await fsExtra.writeFile(outputFile, fileContent);
}

async function createFilePathObjectFile(version) {
    const browser = await puppeteer.launch({
        // devtools: true,
        // headless: false,
        // slowMo: 250,
    });
    const page = await browser.newPage();
    await page.goto(
        `https://system.na0.netsuite.com/help/helpcenter/en_US/srbrowser/Browser${version}/schema/other/recordref.html?mode=package`,
    );

    const rootNetSuiteSchemaUrl = getRootNetSuiteSchemaUrl(version);
    const rootNetSuiteTypesFolder = getRootNetSuiteTypesFolder(version);

    let fileContent =
'const filePaths = {';

    // Get namespace links from the top of the page
    const namespaceLinks = await getNamespaceLinks(page, rootNetSuiteSchemaUrl);

    for (const namespaceLink of namespaceLinks) {
        await page.goto(namespaceLink);

        // Loop over the Record/Search/Other/Enum tabs
        const leftHandTabs = [
            'enum',
            'other',
            'record',
            'search',
        ];

        for (const tab of leftHandTabs) {
            // Get urls for all links on the left-hand side
            const leftDrawerLinks = await getLeftHandDrawerLinks(rootNetSuiteSchemaUrl, page, tab);

            for (const leftDrawerLink of leftDrawerLinks) {
                await page.goto(leftDrawerLink);

                try {
                    // Get the namespace on the page to know the file path to store the generated script
                    const [
                        fileName,
                        filePath,
                    ] = await getPageContent(page, rootNetSuiteTypesFolder);

                    // All tabs except 'enum' need an additional folder level
                    const relativeFilePath = tab !== 'enum'
                        ? `${filePath}/${capitalizeWord(tab)}`
                        : filePath;

                    const projectRootPathIndex = 'netsuite-schema-browser-types/'.length;
                    const projectFilePath = relativeFilePath.slice(projectRootPathIndex);

                    fileContent += `
    ${fileName}: '${projectFilePath}/${fileName}',`;
                } catch(e) {
                    console.log(`Failed to grab data from page, broken link at:\n${leftDrawerLink}`);
                }
            }
        }
    }

    fileContent += `
}

exports.filePaths = filePaths;
`;

    const outputPath = path.resolve(__dirname);
    const outputFile = `${outputPath}/filePath_${version}.js`;

    // Ensure file path exists before we try writing the file
    await fsExtra.ensureDir(outputPath);
    await fsExtra.writeFile(outputFile, fileContent);

    await browser.close();
}

function createFileRow(filePaths, columnNames, row) {
    // ['acctName', 'string', '0..1', 'Name', 'T', 'Sets the account name that displays on all reports.']
    const columnValues = row.split('\t');
    const rowObject = {};
    // {
    //     name: 'acctName',
    //     type: 'string',
    //     cardinality: '0..1',
    //     label: 'Name',
    //     required: 'T',
    //     help: 'Sets the account name that displays on all reports.'
    // }
    for (let [index, value] of Object.entries(columnValues)) {
        rowObject[columnNames[index]] = value;
    }

    // Variable to store potentially-needed import
    let importLine = null;

    // Variables to make processing rows easier
    const netSuiteTypeMapping = {
        dateTime: 'Date',
        double: 'number',
        int: 'number',
        long: 'number',
    };

    // Variables used to generate prop
    const {
        cardinality = '',
        help,
        label,
        name: propName,
        required = '',
        type,
    } = rowObject;
    const [
        minimum,
        maximum,
    ] = cardinality.split('..');
    const propType = Object.hasOwnProperty.call(netSuiteTypeMapping, type)
        ? netSuiteTypeMapping[type]
        : type;
    const propArray = maximum && maximum === 'unbounded'
        ? '[]'
        : '';
    // `propRequired` logic based on NetSuite documentation here:
    // https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_3975713667.html
    const propRequired = required === 'T' || minimum === '1'
        ? ''
        : '?';
    const propComment = help && help !== ''
        ? ` // ${help}`
        : '';

    // Space in template literal below is intentional
    const fileRow = `
    ${propName}${propRequired}: ${propType}${propArray};${propComment}`;

    if (Object.hasOwnProperty.call(filePaths, propType)) {
        importLine =
`import type { ${propType} } from '${filePaths[propType]}';
`;
    }

    return {
        fileRow,
        importLine,
    };
}

async function createFilesForVersion(version) {
    // Create dynamic import here to get the specific version we need
    const { filePaths } = require(`./filePath_${version}`);

    const browser = await puppeteer.launch({
        // devtools: true,
        // headless: false,
        // slowMo: 250,
    });
    const page = await browser.newPage();
    await page.goto(
        `https://system.na0.netsuite.com/help/helpcenter/en_US/srbrowser/Browser${version}/schema/other/recordref.html?mode=package`,
    );

    let fileCount = 0;
    const rootNetSuiteSchemaUrl = getRootNetSuiteSchemaUrl(version);
    const rootNetSuiteTypesFolder = getRootNetSuiteTypesFolder(version);

    // Get namespace links from the top of the page
    const namespaceLinks = await getNamespaceLinks(page, rootNetSuiteSchemaUrl);

    for (const namespaceLink of namespaceLinks) {
        await page.goto(namespaceLink);

        // Loop over the Record/Search/Other/Enum tabs
        const leftHandTabs = [
            'enum',
            'other',
            'record',
            'search',
        ];

        for (const tab of leftHandTabs) {
            // Get urls for all links on the left-hand side
            const leftDrawerLinks = await getLeftHandDrawerLinks(rootNetSuiteSchemaUrl, page, tab);

            for (const leftDrawerLink of leftDrawerLinks) {
                await page.goto(leftDrawerLink);

                try {
                    // Get the namespace on the page to know the file path to store the generated script
                    const [
                        fileName,
                        filePath,
                        rows,
                    ] = await getPageContent(page, rootNetSuiteTypesFolder);

                    // All tabs except 'enum' need an additional folder level
                    const relativeFilePath = tab !== 'enum'
                        ? `${filePath}/${capitalizeWord(tab)}`
                        : filePath;

                    const outputPath = path.resolve(__dirname, `../../${relativeFilePath}`);
                    const outputFile = `${outputPath}/${fileName}.ts`;

                    // Create enum or interface from page content
                    let fileContent = '';

                    // Enum page layout is much different from other pages, so handle them differently
                    if (tab !== 'enum') {
                        fileContent = createInterface(filePaths, leftDrawerLink, fileName, rows);
                    } else {
                        fileContent = createEnum(leftDrawerLink, fileName, rows);
                    }
                    console.log(outputFile);
                    // console.log(fileContent);

                    // Ensure file path exists before we try writing the file
                    await fsExtra.ensureDir(outputPath);
                    await fsExtra.writeFile(outputFile, fileContent);
                    fileCount += 1;
                } catch(e) {
                    console.log(`Failed to grab data from page, broken link at:\n${leftDrawerLink}`);
                }
            }
        }
    }

    console.log(`Total files created: ${fileCount}`);
    await createFilePathEnum(
        `../../netsuite-schema-browser-types/src/${version}/enums`,
        'FilePath',
        filePaths,
    );
    // console.log(JSON.stringify(filePaths, null, 4));

    await browser.close();
}

function createInterface(filePaths, leftDrawerLink, fileName, rows) {
    let attributesInterface = '';
    let attributesProp = '';
    let imports = '';
    const importsSet = new Set();
    let interfaceProps = '';

    // Get an array of the page sections and their respective indices in the `rows` array
    const sections = [
        'Attributes',
        'Fields',
        'Related Record(s)',
        'Related Searches',
    ]
        .reduce((sections, section) => {
            const index = rows.findIndex(row => row === section);
            sections.push([section, index]);
            return sections;
        }, [])
        .filter(([key, value]) => value !== -1)
        .sort(([keyA, valueA], [keyB, valueB]) => valueA - valueB);

    for (const [index, [section, sectionIndex]] of Object.entries(sections)) {
        // Figure out where each section begins and ends
        const startIndex = sectionIndex + 1;
        const endIndex = Number(index) + 1 !== sections.length
            ? sections[Number(index) + 1][1]
            : undefined;

        // Slice that section from the `rows` array so that we can process it
        const sectionRows = rows.slice(startIndex, endIndex);

        // The first row has the column headers, so pull it out of the array
        const columnNamesString = sectionRows.shift();
        // ['name', 'type', 'cardinality', 'label', 'required', 'help']
        const columnNames = columnNamesString.split('\t').map(val => val.toLowerCase());

        // Fields and Attributes sections have to be handled differently
        if (section === 'Attributes') {
            const attributesInterfaceName = `${fileName}Attributes`;

            // Extra new line below is to separate the `attributes` prop from all other props
            attributesProp = `
    attributes: ${attributesInterfaceName};
`;

            attributesInterface = `
export interface ${attributesInterfaceName} {`;

            for (const row of sectionRows) {
                const {
                    fileRow,
                    importLine,
                } = createFileRow(filePaths, columnNames, row);
                attributesInterface += fileRow;

                if (importLine !== null) {
                    importsSet.add(importLine);
                }
            }

            attributesInterface += `
}
`;
        }

        if (section === 'Fields') {
            for (const row of sectionRows) {
                const {
                    fileRow,
                    importLine,
                } = createFileRow(filePaths, columnNames, row);
                interfaceProps += fileRow;

                if (importLine !== null) {
                    importsSet.add(importLine);
                }
            }
        }
    }

    // If we have imports, add them to the top of the script
    if (importsSet.size > 0) {
        imports = Array.from(importsSet)
            .sort(sortImports)
            .join('');

        // Add a new line at the end to separate the imports from the interface comment
        imports += '\n';
    }

    return `${imports}// ${leftDrawerLink}
export interface ${fileName} {${attributesProp}${interfaceProps}
}
${attributesInterface}`;
}

async function getLeftHandDrawerLinks(rootNetSuiteSchemaUrl, page, tab) {
    return page.$$eval(
        `[name="${tab}switch"]`,
        (buttons, rootNetSuiteSchemaUrl) => buttons.map(button => {
            const onClickString = button.onclick.toString();
            const schemaIndex = onClickString.indexOf('schema');
            const lastSingleQuote = onClickString.lastIndexOf('\'');
            const tailNetSuiteSchemaUrl = onClickString.slice(schemaIndex, lastSingleQuote);
            return `${rootNetSuiteSchemaUrl}${tailNetSuiteSchemaUrl}`;
        }),
        rootNetSuiteSchemaUrl,
    );
}

async function getNamespaceLinks(page, rootNetSuiteSchemaUrl) {
    return page.$$eval(
        '#packagesselect > optgroup > option',
        (options, rootNetSuiteSchemaUrl) => options.map(option => {
            const outerHtml = option.outerHTML;
            const schemaIndex = outerHtml.indexOf('schema');
            const lastDoubleQuote = outerHtml.lastIndexOf('"');
            const tailNetSuiteSchemaUrl = outerHtml.slice(schemaIndex, lastDoubleQuote);
            return `${rootNetSuiteSchemaUrl}${tailNetSuiteSchemaUrl}`;
        }),
        rootNetSuiteSchemaUrl,
    );
}

async function getPageContent(page, rootNetSuiteTypesFolder) {
    return page.$eval(
        '#contentPanel',
        (contentPanel, rootNetSuiteTypesFolder) => {
            const [
                fileName,
                urn,
                ...rows
            ] = contentPanel.innerText
                .split('\n')
                .filter(val => val.trim() !== '');

            // Get filepath from URN
            const urnIndex = urn.indexOf('urn:');
            const endOfUrn = urn.lastIndexOf('com') + 3;
            const urnString = urn.slice(urnIndex + 4, endOfUrn);
            const partialFilePath = urnString
                .split('.')
                .reverse()
                .slice(3) // We don't need 'com', 'netsuite', or 'webservices'
                .join('/');
            const filePath = `${rootNetSuiteTypesFolder}${partialFilePath}`;

            return [
                fileName,
                filePath,
                rows,
            ];
        },
        rootNetSuiteTypesFolder,
    );
}

function getRootNetSuiteSchemaUrl(version) {
    return `https://system.na0.netsuite.com/help/helpcenter/en_US/srbrowser/Browser${version}/`;
}

function getRootNetSuiteTypesFolder(version) {
    return `netsuite-schema-browser-types/src/${version}/`;
}

function sortImports(importA, importB) {
    const indexA = importA.indexOf('src/');
    const indexB = importB.indexOf('src/');
    const subA = importA.slice(indexA);
    const subB = importB.slice(indexB);
    return subA.localeCompare(subB);
}

(async () => {
    const versions = [
        '2014_1',
        '2014_2',
        '2015_1',
        '2015_2',
        '2016_1',
        '2016_2',
        '2017_1',
        '2017_2',
        '2018_1',
        '2018_2',
        '2019_1',
        '2019_2',
        '2020_1',
        '2020_2',
        '2021_1',
        '2021_2',
        '2022_1',
    ];

    for (const version of versions) {
        console.log(`Creating 'filePath.js' for version ${version}...`);
        await createFilePathObjectFile(version);
        console.log(`Finished creating 'filePath.js' for version ${version}.`);

        console.log(`Creating files for version ${version}...`);
        await createFilesForVersion(version);
        console.log(`Finished creating files for version ${version}.`);
    }
})();
