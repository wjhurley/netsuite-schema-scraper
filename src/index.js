const fsExtra = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');
const yargs = require('yargs');

const args = yargs
    .boolean('createFilePathObjectFile')
    .boolean('createFilesForAllVersions')
    .boolean('createFilesForNamespace')
    .boolean('createFilesForSingleVersion')
    .boolean('createIndexFilesForAllVersions')
    .boolean('createIndexFilesForSingleVersion')
    .boolean('createSingleFile')
    .boolean('fixImportsForAllVersions')
    .boolean('fixImportsForVersion')
    .string('link')
    .string('namespaceLink')
    .string('netsuiteVersion')
    .argv;

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

async function createFilesForNamespace(namespaceLink) {
    // Get version and tab name from link
    const [
        http,
        url,
        help,
        helpCenter,
        locale,
        srBrowser,
        browserVersion,
        schema,
        tab,
        record,
    ] = namespaceLink.split(/\/+/g);
    const version = browserVersion.slice(7);

    // Create dynamic import here to get the specific version we need
    const { filePaths } = require(`./filePath_${version}`);

    const browser = await puppeteer.launch({
        // devtools: true,
        // headless: false,
        // slowMo: 250,
    });
    const page = await browser.newPage();
    await page.goto(namespaceLink);

    let fileCount = 0;
    const newFilePaths = {};
    const rootNetSuiteSchemaUrl = getRootNetSuiteSchemaUrl(version);
    const rootNetSuiteTypesFolder = getRootNetSuiteTypesFolder(version);

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

                // Create entries for filePath object
                const projectRootPathIndex = 'netsuite-schema-browser-types/'.length;
                const projectFilePath = relativeFilePath.slice(projectRootPathIndex);
                newFilePaths[fileName] = `${projectFilePath}/${fileName}`;

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

                // Ensure file path exists before we try writing the file
                await fsExtra.ensureDir(outputPath);
                await fsExtra.writeFile(outputFile, fileContent);
                fileCount += 1;
            } catch(e) {
                console.error(e);
                console.log(`Failed to grab data from page, broken link at:\n${leftDrawerLink}`);
            }
        }
    }

    console.log(`Total files created: ${fileCount}`);
    console.log(`New entries for filePath object:\n${JSON.stringify(newFilePaths, null, 4)}`);

    await browser.close();
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

function createIndexFileContent(folderContents) {
    return folderContents
        .map(fileOrFolder => `export * from './${fileOrFolder}';`)
        .join('\n');
}

async function createIndexFilesForVersion(version) {
    const versionFolderPath = path.resolve(__dirname, `../../netsuite-schema-browser-types/src/${version}`);

    // Get contents in root version folder
    const versionFolderContents = await fsExtra.readdir(versionFolderPath);
    const {
        files: topLevelNamespaceFiles,
        folders: topLevelNamespaceFolders,
    } = parseFolderContents(versionFolderContents);

    // Create file contents for root version folder index.ts using top-level namespace file and folder names
    const versionFolderFileContent = createIndexFileContent([
        ...topLevelNamespaceFiles,
        ...topLevelNamespaceFolders,
    ]);

    // Create root version folder index.ts file (e.g. src/2014_1/index.ts)
    const versionFolderFile = `${versionFolderPath}/index.ts`;

    // Ensure file path exists before we try writing the file
    await fsExtra.ensureDir(versionFolderPath);
    await fsExtra.writeFile(versionFolderFile, versionFolderFileContent);

    console.log(`Created file ${versionFolderFile}`);

    // Loop over top-level namespace folder names to grab all sub-level namespace file and folder names
    for (const topLevelNamespaceFolder of topLevelNamespaceFolders) {
        const topLevelNamespaceFolderPath = path.resolve(versionFolderPath, topLevelNamespaceFolder);

        // Get contents in top-level namespace folder
        const topLevelNamespaceFolderContents = await fsExtra.readdir(topLevelNamespaceFolderPath);
        const {
            files: subLevelNamespaceFiles,
            folders: subLevelNamespaceFolders,
        } = parseFolderContents(topLevelNamespaceFolderContents);

        // Create file contents for top-level namespace index.ts using sub-level namespace file and folder names
        const topLevelNamespaceFolderFileContent = createIndexFileContent([
            ...subLevelNamespaceFiles,
            ...subLevelNamespaceFolders,
        ]);

        // Create top-level namespace index.ts file (e.g. src/2014_1/activities/index.ts)
        const topLevelNamespaceFolderFile = `${topLevelNamespaceFolderPath}/index.ts`;

        // Ensure file path exists before we try writing the file
        await fsExtra.ensureDir(topLevelNamespaceFolderPath);
        await fsExtra.writeFile(topLevelNamespaceFolderFile, topLevelNamespaceFolderFileContent);

        console.log(`Created file ${topLevelNamespaceFolderFile}`);

        // Loop over sub-level namespace folder names to grab all entity/type folder names
        for (const subLevelNamespaceFolder of subLevelNamespaceFolders) {
            const subLevelNamespaceFolderPath = path.resolve(topLevelNamespaceFolderPath, subLevelNamespaceFolder);

            // Get contents in sub-level namespace folder
            const subLevelNamespaceFolderContents = await fsExtra.readdir(subLevelNamespaceFolderPath);
            const {
                files: entityOrTypeFiles,
                folders: entityOrTypeFolders,
            } = parseFolderContents(subLevelNamespaceFolderContents);

            // Create file contents for sub-level namespace index.ts using entity/type file and folder names
            const subLevelNamespaceFolderFileContent = createIndexFileContent([
                ...entityOrTypeFiles,
                ...entityOrTypeFolders,
            ]);

            // Create sub-level namespace index.ts file (e.g. src/2014_1/activities/scheduling/index.ts)
            const subLevelNamespaceFolderFile = `${subLevelNamespaceFolderPath}/index.ts`;

            // Ensure file path exists before we try writing the file
            await fsExtra.ensureDir(subLevelNamespaceFolderPath);
            await fsExtra.writeFile(subLevelNamespaceFolderFile, subLevelNamespaceFolderFileContent);

            console.log(`Created file ${subLevelNamespaceFolderFile}`);

            // Loop over entity/type folder names to grab all enclosing file names
            for (const entityOrTypeFolder of entityOrTypeFolders) {
                const entityOrTypeFolderPath = path.resolve(subLevelNamespaceFolderPath, entityOrTypeFolder);

                // Get contents in entity or type folder
                const entityOrTypeFolderContents = await fsExtra.readdir(entityOrTypeFolderPath);
                const {
                    files: individualFiles,
                    folders: individualFolders,
                } = parseFolderContents(entityOrTypeFolderContents);

                // Create file contents for entity/type index.ts using enclosing file (and possibly folder) names
                const entityOrTypeFolderFileContent = createIndexFileContent([
                    ...individualFiles,
                    ...individualFolders,
                ]);

                //Create entity/type index.ts file (e.g. src/2014_1/activities/scheduling/Other/index.ts)
                const entityOrTypeFolderFile = `${entityOrTypeFolderPath}/index.ts`;

                // Ensure file path exists before we try writing the file
                await fsExtra.ensureDir(entityOrTypeFolderPath);
                await fsExtra.writeFile(entityOrTypeFolderFile, entityOrTypeFolderFileContent);

                console.log(`Created file ${entityOrTypeFolderFile}`);
            }
        }
    }
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

async function createSingleFile(link) {
    // Get version and tab name from link
    const [
        http,
        url,
        help,
        helpCenter,
        locale,
        srBrowser,
        browserVersion,
        schema,
        tab,
        record,
    ] = link.split(/\/+/g);
    const version = browserVersion.slice(7);

    // Create dynamic import here to get the specific version we need
    const { filePaths } = require(`./filePath_${version}`);

    const browser = await puppeteer.launch({
        // devtools: true,
        // headless: false,
        // slowMo: 1000,
    });
    const page = await browser.newPage();
    await page.goto(link);

    const rootNetSuiteTypesFolder = getRootNetSuiteTypesFolder(version);

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
            fileContent = createInterface(filePaths, link, fileName, rows);
        } else {
            fileContent = createEnum(link, fileName, rows);
        }

        // Ensure file path exists before we try writing the file
        await fsExtra.ensureDir(outputPath);
        await fsExtra.writeFile(outputFile, fileContent);

        console.log(`New file created:\n${outputFile}`);
    } catch (e) {
        console.error(e);
        console.log(`Failed to grab data from page, broken link at:\n${link}`);
    }

    await browser.close();
}

function doesFileContentIncludeFullImports(fileContent) {
    const regex = getImportRegex();

    return fileContent.search(regex) > -1;
}

async function fixImportsForVersion(version) {
    const versionFolderPath = path.resolve(__dirname, `../../netsuite-schema-browser-types/src/${version}`);

    // Get contents in root version folder
    const versionFolderContents = await fsExtra.readdir(versionFolderPath);
    const {
        files: topLevelNamespaceFiles,
        folders: topLevelNamespaceFolders,
    } = parseFolderContents(versionFolderContents);

    for (const file of topLevelNamespaceFiles) {
        const topLevelNamespaceFile = `${versionFolderPath}/${file}.ts`;
        const fileContent = await fsExtra.readFile(topLevelNamespaceFile, 'utf8');

        if (doesFileContentIncludeFullImports(fileContent)) {
            console.log(`Updating imports for ${topLevelNamespaceFile}...`);

            const newFileContent = replaceFullImports(topLevelNamespaceFile, fileContent);

            // Ensure file path exists before we try writing the file
            await fsExtra.ensureDir(versionFolderPath);
            await fsExtra.writeFile(topLevelNamespaceFile, newFileContent);

            console.log(`Finished updating imports for ${topLevelNamespaceFile}`);
        }
    }

    // Loop over top-level namespace folder names to grab all sub-level namespace file and folder names
    for (const topLevelNamespaceFolder of topLevelNamespaceFolders) {
        const topLevelNamespaceFolderPath = path.resolve(versionFolderPath, topLevelNamespaceFolder);

        // Get contents in top-level namespace folder
        const topLevelNamespaceFolderContents = await fsExtra.readdir(topLevelNamespaceFolderPath);
        const {
            files: subLevelNamespaceFiles,
            folders: subLevelNamespaceFolders,
        } = parseFolderContents(topLevelNamespaceFolderContents);

        for (const file of subLevelNamespaceFiles) {
            const subLevelNamespaceFile = `${topLevelNamespaceFolderPath}/${file}.ts`;
            const fileContent = await fsExtra.readFile(subLevelNamespaceFile, 'utf8');

            if (doesFileContentIncludeFullImports(fileContent)) {
                console.log(`Updating imports for ${subLevelNamespaceFile}...`);

                const newFileContent = replaceFullImports(subLevelNamespaceFile, fileContent);

                // Ensure file path exists before we try writing the file
                await fsExtra.ensureDir(topLevelNamespaceFolderPath);
                await fsExtra.writeFile(subLevelNamespaceFile, newFileContent);

                console.log(`Finished updating imports for ${subLevelNamespaceFile}`);
            }
        }

        // Loop over sub-level namespace folder names to grab all entity/type file and folder names
        for (const subLevelNamespaceFolder of subLevelNamespaceFolders) {
            const subLevelNamespaceFolderPath = path.resolve(topLevelNamespaceFolderPath, subLevelNamespaceFolder);

            // Get contents in sub-level namespace folder
            const subLevelNamespaceFolderContents = await fsExtra.readdir(subLevelNamespaceFolderPath);
            const {
                files: entityOrTypeFiles,
                folders: entityOrTypeFolders,
            } = parseFolderContents(subLevelNamespaceFolderContents);

            for (const file of entityOrTypeFiles) {
                const entityOrTypeFile = `${subLevelNamespaceFolderPath}/${file}.ts`;
                const fileContent = await fsExtra.readFile(entityOrTypeFile, 'utf8');

                if (doesFileContentIncludeFullImports(fileContent)) {
                    console.log(`Updating imports for ${entityOrTypeFile}...`);

                    const newFileContent = replaceFullImports(entityOrTypeFile, fileContent);

                    // Ensure file path exists before we try writing the file
                    await fsExtra.ensureDir(subLevelNamespaceFolderPath);
                    await fsExtra.writeFile(entityOrTypeFile, newFileContent);

                    console.log(`Finished updating imports for ${entityOrTypeFile}`);
                }
            }

            // Loop over entity/type folder names to grab all enclosing file names
            for (const entityOrTypeFolder of entityOrTypeFolders) {
                const entityOrTypeFolderPath = path.resolve(subLevelNamespaceFolderPath, entityOrTypeFolder);

                // Get contents in entity or type folder
                const entityOrTypeFolderContents = await fsExtra.readdir(entityOrTypeFolderPath);
                const {
                    files: individualFiles,
                    folders: individualFolders,
                } = parseFolderContents(entityOrTypeFolderContents);

                for (const file of individualFiles) {
                    const individualFile = `${entityOrTypeFolderPath}/${file}.ts`;
                    const fileContent = await fsExtra.readFile(individualFile, 'utf8');

                    if (doesFileContentIncludeFullImports(fileContent)) {
                        console.log(`Updating imports for ${individualFile}...`);

                        const newFileContent = replaceFullImports(individualFile, fileContent);

                        // Ensure file path exists before we try writing the file
                        await fsExtra.ensureDir(entityOrTypeFolderPath);
                        await fsExtra.writeFile(individualFile, newFileContent);

                        console.log(`Finished updating imports for ${individualFile}`);
                    }
                }
            }
        }
    }
}

function getImportRegex() {
    return /(import\s+type\s+\{\s*\w+\s*\}\s+from\s+\')(src[A-Za-z0-9_\/-]+)(\'\;)/;
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

function parseFolderContents(contents) {
    const folderContents = {
        files: [],
        folders: [],
    };

    for (const content of contents) {
        if (content.indexOf('.') === -1) {
            // content is a folder
            folderContents.folders.push(content);
        }

        if (content.includes('.ts') && content !== 'index.ts') {
            // content is a file (other than index.ts)
            folderContents.files.push(content.replace('.ts', ''));
        }
    }

    return folderContents;
}

function replaceFullImports(filePath, fileContent) {
    const filePathIndex = filePath.indexOf('src/');
    const filePathParts = filePath
        .slice(filePathIndex)
        .split('/');
    const regex = getImportRegex();

    return fileContent
        .split('\n')
        .map(fileContentLine => {
            const regexResults = fileContentLine.match(regex);

            if (regexResults === null) {
                return fileContentLine;
            }

            const [
                fullImport,
                importStart,
                importPath,
                importEnd,
            ] = regexResults;
            const importPathParts = importPath.split('/');
            const newImportPathParts = [];
            const relativePathPortion = '..';
            let count = 0;
            let isDifferentPath = false;

            for (let i = 0; i < importPathParts.length; i += 1) {
                const filePathPart = filePathParts[i];
                const importPathPart = importPathParts[i];

                if (filePathPart === importPathPart && !isDifferentPath) {
                    continue;
                }

                // Since folders in sub-level namespace folders use the same names,
                // we need to flip this boolean once the folder paths don't match
                isDifferentPath = true;

                newImportPathParts.push(importPathPart);

                // We don't want to increment on the last iteration (file name)
                if (i < importPathParts.length - 1) {
                    count += 1;
                }
            }

            const relativePathPortions = count !== 0
                ? Array(count).fill(relativePathPortion)
                : ['.'];
            const newImportPath = [
                ...relativePathPortions,
                ...newImportPathParts,
            ].join('/');

            return [
                importStart,
                newImportPath,
                importEnd,
            ].join('');
        })
        .join('\n');
}

function sortImports(importA, importB) {
    const indexA = importA.indexOf('src/');
    const indexB = importB.indexOf('src/');
    const subA = importA.slice(indexA);
    const subB = importB.slice(indexB);
    return subA.localeCompare(subB);
}

async function main() {
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

    if (args.createFilesForAllVersions) {
        for (const version of versions) {
            console.log(`Creating 'filePath.js' for version ${version}...`);
            await createFilePathObjectFile(version);
            console.log(`Finished creating 'filePath.js' for version ${version}.`);

            console.log(`Creating files for version ${version}...`);
            await createFilesForVersion(version);
            console.log(`Finished creating files for version ${version}.`);
        }
    }

    if (args.createFilesForSingleVersion && args.netsuiteVersion) {
        const { netsuiteVersion: version } = args;

        console.log(`Creating 'filePath.js' for version ${version}...`);
        await createFilePathObjectFile(version);
        console.log(`Finished creating 'filePath.js' for version ${version}.`);

        console.log(`Creating files for version ${version}...`);
        await createFilesForVersion(version);
        console.log(`Finished creating files for version ${version}.`);
    }

    if (args.createFilesForNamespace && args.namespaceLink) {
        const { namespaceLink } = args;

        console.log(`Creating namespace files from link ${namespaceLink}...`);
        await createFilesForNamespace(namespaceLink);
        console.log(`Finished creating namespace files from link ${namespaceLink}.`);
    }

    if (args.createSingleFile && args.link) {
        const { link } = args;

        console.log(`Creating file for page ${link}...`);
        await createSingleFile(link);
        console.log(`Finished creating file for page ${link}.`);
    }

    if (args.createFilePathObjectFile && args.netsuiteVersion) {
        const { netsuiteVersion: version } = args;

        console.log(`Creating 'filePath' file for version ${version}...`);
        await createFilePathObjectFile(version);
        console.log(`Finished creating 'filePath' file for version ${version}.`);
    }

    if (args.createIndexFilesForAllVersions) {
        for (const version of versions) {
            console.log(`Creating index files for version ${version}...`);
            await createFilePathObjectFile(version);
            console.log(`Finished creating index files for version ${version}.`);
        }
    }

    if (args.createIndexFilesForSingleVersion && args.netsuiteVersion) {
        const { netsuiteVersion: version } = args;

        console.log(`Creating index files for version ${version}...`);
        await createIndexFilesForVersion(version);
        console.log(`Finished creating index files for version ${version}.`);
    }

    if (args.fixImportsForAllVersions) {
        for (const version of versions) {
            console.log(`Fixing imports for version ${version}...`);
            await fixImportsForVersion(version);
            console.log(`Finished fixing imports for version ${version}.`);
        }
    }

    if (args.fixImportsForVersion && args.netsuiteVersion) {
        const { netsuiteVersion: version } = args;

        console.log(`Fixing imports for version ${version}...`);
        await fixImportsForVersion(version);
        console.log(`Finished fixing imports for version ${version}.`);
    }
}

main()
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
