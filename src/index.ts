import * as FsExtra from 'fs-extra';
import * as Path from 'path';
import * as Puppeteer from 'puppeteer';
import * as Yargs from 'yargs';

import { logger } from 'src/logger';

interface Arguments {
    createFilePathObjectFile: boolean;
    createFilesForAllVersions: boolean;
    createFilesForNamespace: boolean;
    createFilesForSingleVersion: boolean;
    createIndexFilesForAllVersions: boolean;
    createIndexFilesForSingleVersion: boolean;
    createSingleFile: boolean;
    fixImportsForAllVersions: boolean;
    fixImportsForVersion: boolean;
    link: string;
    namespaceLink: string;
    netsuiteVersion: string;
}

interface FileRow {
    fileRow: string;
    importLine: string | null;
}

interface FolderContents {
    files: string[];
    folders: string[];
}

interface GenericObject {
    [key: string]: string;
}

const args: {
    createFilePathObjectFile: boolean;
    createFilesForAllVersions: boolean;
    createFilesForNamespace: boolean;
    createFilesForSingleVersion: boolean;
    createIndexFilesForAllVersions: boolean;
    createIndexFilesForSingleVersion: boolean;
    createSingleFile: boolean;
    fixImportsForAllVersions: boolean;
    fixImportsForVersion: boolean;
    link: string;
    namespaceLink: string;
    netsuiteVersion: string;
} = Yargs
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
    .argv as Arguments;

/* eslint-disable @typescript-eslint/no-use-before-define */

/**
 * Capitalizes the first letter in a word.
 * @param {string} word - The word to be capitalized.
 * @returns {string}
 */
function capitalizeWord(word: string): string {
    return word[0].toUpperCase() + word.slice(1);
}

/**
 * Case-insensitive sort function to be used as `compareFn` parameter to `Array.prototype.sort()`.
 * @param {string} a - first string to compare
 * @param {string} b - second string to compare
 * @returns {number}
 */
function caseInsensitiveSort(a: string, b: string): number {
    return a.localeCompare(b);
}

/**
 * Creates a TypeScript enum from a page in the NetSuite Schema Browser.
 * @param {string} leftDrawerLink - The URL this enum was generated from.
 * @param {string} fileName - The filename to be used as the name of the enum.
 * @param {string[]} rows - The rows of text taken from the webpage.
 * @returns {string}
 */
function createEnum(
    leftDrawerLink: string,
    fileName: string,
    rows: string[],
): string {
    let fileContent = `// ${leftDrawerLink}
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

/**
 * @typedef {Object} FilePaths
 * @property {string} [key: {string}]
 */

/**
 * Creates a TypeScript enum of all scripts for a specific version of NetSuite.
 * @param {string} relativeFilePath - The relative filepath where the FilePath enum will be stored.
 * @param {string} fileName - The filename to be used as the name of the enum.
 * @param {FilePaths} filePaths - The filePath object created for a specific version of NetSuite.
 * @returns {Promise<void>}
 */
async function createFilePathEnum(
    relativeFilePath: string,
    fileName: string,
    filePaths: GenericObject,
): Promise<void> {
    const outputPath = Path.resolve(__dirname, relativeFilePath);
    const outputFile = `${outputPath}/${fileName}.ts`;

    // Check if file already exists before we go any further
    const doesFileAlreadyExist = await FsExtra.pathExists(outputFile);

    if (doesFileAlreadyExist) {
        logger.info(`FilePath enum already exists at ${outputFile}, skipping.`);
        return;
    }

    const sortedFilePathArray = Object.entries(filePaths)
        .sort(
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            ([ keyA, valueA ], [ keyB, valueB ]) => valueA.localeCompare(valueB),
        );
    let previousParentFolder = '';

    let fileContent = `export enum ${fileName} {`;

    for (const [ localFileName, filePath ] of sortedFilePathArray) {
        const parentFolderIndex = filePath.lastIndexOf('/');
        const parentFolder = filePath.slice(0, parentFolderIndex + 1);

        // Add a new line in between enum entries for different parent folders
        const newLineOrEmptyString = previousParentFolder !== '' && previousParentFolder !== parentFolder
            ? '\n'
            : '';

        fileContent += `
${newLineOrEmptyString}    ${localFileName} = '${filePath}',`;
        previousParentFolder = parentFolder;
    }

    fileContent += `
}
`;

    // Ensure file path exists before we try writing the file
    await FsExtra.ensureDir(outputPath);
    await FsExtra.writeFile(outputFile, fileContent);
}

/**
 * Creates a JavaScript file that exports a filePath object for a specific version of NetSuite.
 * @param {string} version - The version of NetSuite.
 * @returns {Promise<void>}
 */
async function createFilePathObjectFile(version: string): Promise<void> {
    const rootNetSuiteSchemaUrl = getRootNetSuiteSchemaUrl(version);
    const browser = await Puppeteer.launch({
        // devtools: true,
        headless: 'new',
        // slowMo: 250,
    });
    const page = await browser.newPage();
    await page.goto(
        `${rootNetSuiteSchemaUrl}schema/other/recordref.html?mode=package`,
    );

    const rootNetSuiteTypesFolder = getRootNetSuiteTypesFolder(version);
    const fileContentLines: string[] = [];

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

                    fileContentLines.push(`    ${fileName}: '${projectFilePath}/${fileName}',`);
                } catch (e) {
                    logger.error(e);
                    logger.warn(`Failed to grab data from page, broken link at:\n${leftDrawerLink}`);
                }
            }
        }
    }

    const props = fileContentLines
        .sort(caseInsensitiveSort)
        .join('\n');
    const fileContent = `export const filePaths = {
${props}
};\n`;

    const outputPath = Path.resolve(__dirname);
    const outputFile = `${outputPath}/filePath_${version}.ts`;

    // Ensure file path exists before we try writing the file
    await FsExtra.ensureDir(outputPath);
    await FsExtra.writeFile(outputFile, fileContent);

    await browser.close();
}

/**
 * @typedef {Object} FileRow
 * @property {string} fileRow - The line of text representing a TypeScript interface property
 * @property {string | null} importLine - The import for the TypeScript interface property type, if necessary.
 */

/**
 * Creates a string representing a TypeScript interface property.
 * @param {FilePaths} filePaths - The filePath object created for a specific version of NetSuite.
 * @param {string[]} columnNames - The column names from the table on the webpage.
 * @param {string} row - The rows of text taken from the webpage.
 * @returns {FileRow}
 */
function createFileRow(
    filePaths: GenericObject,
    columnNames: string[],
    row: string,
): FileRow {
    // ['acctName', 'string', '0..1', 'Name', 'T', 'Sets the account name that displays on all reports.']
    const columnValues = row.split('\t');
    const rowObject: GenericObject = {};

    // {
    //     name: 'acctName',
    //     type: 'string',
    //     cardinality: '0..1',
    //     label: 'Name',
    //     required: 'T',
    //     help: 'Sets the account name that displays on all reports.'
    // }
    for (const [ index, value ] of Object.entries(columnValues)) {
        rowObject[columnNames[Number(index)]] = value;
    }

    // Variable to store potentially-needed import
    let importLine = null;

    // Variables to make processing rows easier
    const netSuiteTypeMapping: GenericObject = {
        dateTime: 'Date',
        double: 'number',
        int: 'number',
        long: 'number',
    };

    // Variables used to generate prop
    const {
        cardinality = '',
        help,
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
        importLine = `import type { ${propType} } from '${filePaths[propType]}';
`;
    }

    return {
        fileRow,
        importLine,
    };
}

/**
 * Creates all interfaces and enums for a specific namespace and version of NetSuite.
 * @param {string} namespaceLink - The URL to a specific namespace and version in NetSuite Schema Browser.
 * @returns {Promise<void>}
 */
async function createFilesForNamespace(namespaceLink: string): Promise<void> {
    /* eslint-disable @typescript-eslint/no-unused-vars */
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
    /* eslint-enable @typescript-eslint/no-unused-vars */
    const version = browserVersion.slice(7);

    // Create dynamic import here to get the specific version we need
    const { filePaths } = require(`./filePath_${version}`); // eslint-disable-line global-require

    const browser = await Puppeteer.launch({
        // devtools: true,
        headless: 'new',
        // slowMo: 250,
    });
    const page = await browser.newPage();
    await page.goto(namespaceLink);

    let fileCount = 0;
    const newFilePaths: GenericObject = {};
    const rootNetSuiteSchemaUrl = getRootNetSuiteSchemaUrl(version);
    const rootNetSuiteTypesFolder = getRootNetSuiteTypesFolder(version);

    // Loop over the Record/Search/Other/Enum tabs
    const leftHandTabs = [
        'enum',
        'other',
        'record',
        'search',
    ];

    // eslint-disable-next-line @typescript-eslint/no-shadow
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
                    ...rows
                ] = await getPageContent(page, rootNetSuiteTypesFolder);

                // All tabs except 'enum' need an additional folder level
                const relativeFilePath = tab !== 'enum'
                    ? `${filePath}/${capitalizeWord(tab)}`
                    : filePath;

                // Create entries for filePath object
                const projectRootPathIndex = 'netsuite-schema-browser-types/'.length;
                const projectFilePath = relativeFilePath.slice(projectRootPathIndex);
                newFilePaths[fileName] = `${projectFilePath}/${fileName}`;

                const outputPath = Path.resolve(__dirname, `../../${relativeFilePath}`);
                const outputFile = `${outputPath}/${fileName}.ts`;

                // Create enum or interface from page content
                let fileContent = '';

                // Enum page layout is much different from other pages, so handle them differently
                if (tab !== 'enum') {
                    fileContent = createInterface(filePaths, leftDrawerLink, fileName, rows);
                } else {
                    fileContent = createEnum(leftDrawerLink, fileName, rows);
                }
                logger.info(outputFile);

                // Ensure file path exists before we try writing the file
                await FsExtra.ensureDir(outputPath);
                await FsExtra.writeFile(outputFile, fileContent);
                fileCount += 1;
            } catch (e) {
                logger.error(e);
                logger.warn(`Failed to grab data from page, broken link at:\n${leftDrawerLink}`);
            }
        }
    }

    logger.info(`Total files created: ${fileCount}`);
    logger.info(`New entries for filePath object:\n${JSON.stringify(newFilePaths, null, 4)}`);

    await browser.close();
}

/**
 * Creates all interfaces and enums for a specific version of NetSuite.
 * @param {string} version - The version of NetSuite.
 * @returns {Promise<void>}
 */
async function createFilesForVersion(version: string): Promise<void> {
    // Create dynamic import here to get the specific version we need
    const { filePaths } = require(`./filePath_${version}`); // eslint-disable-line global-require

    const rootNetSuiteSchemaUrl = getRootNetSuiteSchemaUrl(version);
    const browser = await Puppeteer.launch({
        // devtools: true,
        headless: 'new',
        // slowMo: 250,
    });
    const page = await browser.newPage();
    await page.goto(
        `${rootNetSuiteSchemaUrl}schema/other/recordref.html?mode=package`,
    );

    let fileCount = 0;
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
                        ...rows
                    ] = await getPageContent(page, rootNetSuiteTypesFolder);

                    // All tabs except 'enum' need an additional folder level
                    const relativeFilePath = tab !== 'enum'
                        ? `${filePath}/${capitalizeWord(tab)}`
                        : filePath;

                    const outputPath = Path.resolve(__dirname, `../../${relativeFilePath}`);
                    const outputFile = `${outputPath}/${fileName}.ts`;

                    // Create enum or interface from page content
                    let fileContent = '';

                    // Enum page layout is much different from other pages, so handle them differently
                    if (tab !== 'enum') {
                        fileContent = createInterface(filePaths, leftDrawerLink, fileName, rows);
                    } else {
                        fileContent = createEnum(leftDrawerLink, fileName, rows);
                    }

                    // Ensure file path exists before we try writing the file
                    await FsExtra.ensureDir(outputPath);
                    await FsExtra.writeFile(outputFile, fileContent);
                    fileCount += 1;
                } catch (e) {
                    logger.error(e);
                    logger.warn(`Failed to grab data from page, broken link at:\n${leftDrawerLink}`);
                }
            }
        }
    }

    logger.info(`Total files created: ${fileCount}`);
    await createFilePathEnum(
        `../../netsuite-schema-browser-types/src/${version}/enums`,
        'FilePath',
        filePaths,
    );
    // logger.info(JSON.stringify(filePaths, null, 4));

    await browser.close();
}

/**
 * Creates an index file for a folder based on the contents of that folder.
 * @param {string[]} folderContents - The folder contents from a directory.
 * @returns {string}
 */
function createIndexFileContent(folderContents: string[]): string {
    return folderContents
        .map(fileOrFolder => `export * from './${fileOrFolder}';`)
        .join('\n');
}

/**
 * Creates all index files for the specified version of NetSuite.
 * @param {string} version - The rows of text taken from the webpage.
 * @returns {Promise<void>}
 */
async function createIndexFilesForVersion(version: string): Promise<void> {
    const versionFolderPath = Path.resolve(__dirname, `../../netsuite-schema-browser-types/src/${version}`);

    // Get contents in root version folder
    const versionFolderContents = await FsExtra.readdir(versionFolderPath);
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
    await FsExtra.ensureDir(versionFolderPath);
    await FsExtra.writeFile(versionFolderFile, versionFolderFileContent);

    logger.info(`Created file ${versionFolderFile}`);

    // Loop over top-level namespace folder names to grab all sub-level namespace file and folder names
    for (const topLevelNamespaceFolder of topLevelNamespaceFolders) {
        const topLevelNamespaceFolderPath = Path.resolve(versionFolderPath, topLevelNamespaceFolder);

        // Get contents in top-level namespace folder
        const topLevelNamespaceFolderContents = await FsExtra.readdir(topLevelNamespaceFolderPath);
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
        await FsExtra.ensureDir(topLevelNamespaceFolderPath);
        await FsExtra.writeFile(topLevelNamespaceFolderFile, topLevelNamespaceFolderFileContent);

        logger.info(`Created file ${topLevelNamespaceFolderFile}`);

        // Loop over sub-level namespace folder names to grab all entity/type folder names
        for (const subLevelNamespaceFolder of subLevelNamespaceFolders) {
            const subLevelNamespaceFolderPath = Path.resolve(topLevelNamespaceFolderPath, subLevelNamespaceFolder);

            // Get contents in sub-level namespace folder
            const subLevelNamespaceFolderContents = await FsExtra.readdir(subLevelNamespaceFolderPath);
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
            await FsExtra.ensureDir(subLevelNamespaceFolderPath);
            await FsExtra.writeFile(subLevelNamespaceFolderFile, subLevelNamespaceFolderFileContent);

            logger.info(`Created file ${subLevelNamespaceFolderFile}`);

            // Loop over entity/type folder names to grab all enclosing file names
            for (const entityOrTypeFolder of entityOrTypeFolders) {
                const entityOrTypeFolderPath = Path.resolve(subLevelNamespaceFolderPath, entityOrTypeFolder);

                // Get contents in entity or type folder
                const entityOrTypeFolderContents = await FsExtra.readdir(entityOrTypeFolderPath);
                const {
                    files: individualFiles,
                    folders: individualFolders,
                } = parseFolderContents(entityOrTypeFolderContents);

                // Create file contents for entity/type index.ts using enclosing file (and possibly folder) names
                const entityOrTypeFolderFileContent = createIndexFileContent([
                    ...individualFiles,
                    ...individualFolders,
                ]);

                // Create entity/type index.ts file (e.g. src/2014_1/activities/scheduling/Other/index.ts)
                const entityOrTypeFolderFile = `${entityOrTypeFolderPath}/index.ts`;

                // Ensure file path exists before we try writing the file
                await FsExtra.ensureDir(entityOrTypeFolderPath);
                await FsExtra.writeFile(entityOrTypeFolderFile, entityOrTypeFolderFileContent);

                logger.info(`Created file ${entityOrTypeFolderFile}`);
            }
        }
    }
}

/**
 * Creates a TypeScript interface from a page in the NetSuite Schema Browser.
 * @param {FilePaths} filePaths - The filePath object created for a specific version of NetSuite.
 * @param {string} leftDrawerLink - The URL this interface was generated from.
 * @param {string} fileName - The filename to be used as the name of the interface.
 * @param {string[]} rows - The rows of text taken from the webpage.
 * @returns {string}
 */
function createInterface(
    filePaths: GenericObject,
    leftDrawerLink: string,
    fileName: string,
    rows: string[],
): string {
    let attributesInterface = '';
    let attributesProp = '';
    let imports = '';
    const importsSet = new Set<string>();
    let interfaceProps = '';

    // Get an array of the page sections and their respective indices in the `rows` array
    const pageSections = [
        'Attributes',
        'Fields',
        'Related Record(s)',
        'Related Searches',
    ]
        .reduce((sections, section) => {
            const index = rows.findIndex(row => row === section);
            sections.push([ section, index ]);
            return sections;
        }, [] as [string, number][])
        .filter(([ key, value ]) => value !== -1) // eslint-disable-line @typescript-eslint/no-unused-vars
        .sort(([ keyA, valueA ], [ keyB, valueB ]) => valueA - valueB); // eslint-disable-line @typescript-eslint/no-unused-vars

    for (const [ index, [ section, sectionIndex ] ] of Object.entries(pageSections)) {
        // Figure out where each section begins and ends
        const startIndex = sectionIndex + 1;
        const endIndex = Number(index) + 1 !== pageSections.length
            ? pageSections[Number(index) + 1][1]
            : undefined;

        // Slice that section from the `rows` array so that we can process it
        const sectionRows = rows.slice(startIndex, endIndex);

        // The first row has the column headers, so pull it out of the array
        const columnNamesString = sectionRows.shift();
        // ['name', 'type', 'cardinality', 'label', 'required', 'help']
        const columnNames = columnNamesString?.split('\t').map(val => val.toLowerCase());

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
                } = createFileRow(filePaths, columnNames ?? [], row);
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
                } = createFileRow(filePaths, columnNames ?? [], row);
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

/**
 * Creates a single TypeScript file using the contents of a page in the NetSuite Schema Browser.
 * @param {string} link - The URL for a specific page in the NetSuite Schema Browser.
 * @returns {Promise<void>}
 */
async function createSingleFile(link: string): Promise<void> {
    // Get version and tab name from link
    /* eslint-disable @typescript-eslint/no-unused-vars */
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
    /* eslint-enable @typescript-eslint/no-unused-vars */

    const version = browserVersion.slice(7);

    // Create dynamic import here to get the specific version we need
    const { filePaths } = require(`./filePath_${version}`); // eslint-disable-line global-require

    const browser = await Puppeteer.launch({
        // devtools: true,
        headless: 'new',
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
            ...rows
        ] = await getPageContent(page, rootNetSuiteTypesFolder);

        // All tabs except 'enum' need an additional folder level
        const relativeFilePath = tab !== 'enum'
            ? `${filePath}/${capitalizeWord(tab)}`
            : filePath;

        const outputPath = Path.resolve(__dirname, `../../${relativeFilePath}`);
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
        await FsExtra.ensureDir(outputPath);
        await FsExtra.writeFile(outputFile, fileContent);

        logger.info(`New file created:\n${outputFile}`);
    } catch (e) {
        logger.error(e);
        logger.info(`Failed to grab data from page, broken link at:\n${link}`);
    }

    await browser.close();
}

/**
 * Checks a script's file contents to determine if they contain a non-relative import.
 * @param {string} fileContent - The file content for a specific enum or interface.
 * @returns {boolean}
 */
function doesFileContentIncludeFullImports(fileContent: string): boolean {
    const regex = getImportRegex();

    return fileContent.search(regex) > -1;
}

/**
 * Fixes all non-relative imports in all scripts for a specific version of NetSuite.
 * @param {string} version - The version of NetSuite.
 * @returns {Promise<void>}
 */
async function fixImportsForVersion(version: string): Promise<void> {
    const versionFolderPath = Path.resolve(__dirname, `../../netsuite-schema-browser-types/src/${version}`);

    // Get contents in root version folder
    const versionFolderContents = await FsExtra.readdir(versionFolderPath);
    const {
        files: topLevelNamespaceFiles,
        folders: topLevelNamespaceFolders,
    } = parseFolderContents(versionFolderContents);

    for (const file of topLevelNamespaceFiles) {
        const topLevelNamespaceFile = `${versionFolderPath}/${file}.ts`;
        const fileContent = await FsExtra.readFile(topLevelNamespaceFile, 'utf8');

        if (doesFileContentIncludeFullImports(fileContent)) {
            logger.info(`Updating imports for ${topLevelNamespaceFile}...`);

            const newFileContent = replaceFullImports(topLevelNamespaceFile, fileContent);

            // Ensure file path exists before we try writing the file
            await FsExtra.ensureDir(versionFolderPath);
            await FsExtra.writeFile(topLevelNamespaceFile, newFileContent);

            logger.info(`Finished updating imports for ${topLevelNamespaceFile}`);
        }
    }

    // Loop over top-level namespace folder names to grab all sub-level namespace file and folder names
    for (const topLevelNamespaceFolder of topLevelNamespaceFolders) {
        const topLevelNamespaceFolderPath = Path.resolve(versionFolderPath, topLevelNamespaceFolder);

        // Get contents in top-level namespace folder
        const topLevelNamespaceFolderContents = await FsExtra.readdir(topLevelNamespaceFolderPath);
        const {
            files: subLevelNamespaceFiles,
            folders: subLevelNamespaceFolders,
        } = parseFolderContents(topLevelNamespaceFolderContents);

        for (const file of subLevelNamespaceFiles) {
            const subLevelNamespaceFile = `${topLevelNamespaceFolderPath}/${file}.ts`;
            const fileContent = await FsExtra.readFile(subLevelNamespaceFile, 'utf8');

            if (doesFileContentIncludeFullImports(fileContent)) {
                logger.info(`Updating imports for ${subLevelNamespaceFile}...`);

                const newFileContent = replaceFullImports(subLevelNamespaceFile, fileContent);

                // Ensure file path exists before we try writing the file
                await FsExtra.ensureDir(topLevelNamespaceFolderPath);
                await FsExtra.writeFile(subLevelNamespaceFile, newFileContent);

                logger.info(`Finished updating imports for ${subLevelNamespaceFile}`);
            }
        }

        // Loop over sub-level namespace folder names to grab all entity/type file and folder names
        for (const subLevelNamespaceFolder of subLevelNamespaceFolders) {
            const subLevelNamespaceFolderPath = Path.resolve(topLevelNamespaceFolderPath, subLevelNamespaceFolder);

            // Get contents in sub-level namespace folder
            const subLevelNamespaceFolderContents = await FsExtra.readdir(subLevelNamespaceFolderPath);
            const {
                files: entityOrTypeFiles,
                folders: entityOrTypeFolders,
            } = parseFolderContents(subLevelNamespaceFolderContents);

            for (const file of entityOrTypeFiles) {
                const entityOrTypeFile = `${subLevelNamespaceFolderPath}/${file}.ts`;
                const fileContent = await FsExtra.readFile(entityOrTypeFile, 'utf8');

                if (doesFileContentIncludeFullImports(fileContent)) {
                    logger.info(`Updating imports for ${entityOrTypeFile}...`);

                    const newFileContent = replaceFullImports(entityOrTypeFile, fileContent);

                    // Ensure file path exists before we try writing the file
                    await FsExtra.ensureDir(subLevelNamespaceFolderPath);
                    await FsExtra.writeFile(entityOrTypeFile, newFileContent);

                    logger.info(`Finished updating imports for ${entityOrTypeFile}`);
                }
            }

            // Loop over entity/type folder names to grab all enclosing file names
            for (const entityOrTypeFolder of entityOrTypeFolders) {
                const entityOrTypeFolderPath = Path.resolve(subLevelNamespaceFolderPath, entityOrTypeFolder);

                // Get contents in entity or type folder
                const entityOrTypeFolderContents = await FsExtra.readdir(entityOrTypeFolderPath);
                const {
                    files: individualFiles,
                    // folders: individualFolders,
                } = parseFolderContents(entityOrTypeFolderContents);

                for (const file of individualFiles) {
                    const individualFile = `${entityOrTypeFolderPath}/${file}.ts`;
                    const fileContent = await FsExtra.readFile(individualFile, 'utf8');

                    if (doesFileContentIncludeFullImports(fileContent)) {
                        logger.info(`Updating imports for ${individualFile}...`);

                        const newFileContent = replaceFullImports(individualFile, fileContent);

                        // Ensure file path exists before we try writing the file
                        await FsExtra.ensureDir(entityOrTypeFolderPath);
                        await FsExtra.writeFile(individualFile, newFileContent);

                        logger.info(`Finished updating imports for ${individualFile}`);
                    }
                }
            }
        }
    }
}

/**
 * Creates a RegExp object specifically for finding non-relative imports in scripts.
 * @returns {RegExp}
 */
function getImportRegex(): RegExp {
    return /(import\s+type\s+\{\s*\w+\s*\}\s+from\s+')(src[A-Za-z0-9_/-]+)(';)/;
}

/**
 * Gets all links for a specific tab in the left-hand navigation of the NetSuite Schema Browser.
 * @param {string} rootNetSuiteSchemaUrl - The root NetSuite Schema Browser URL for a specific version of NetSuite.
 * @param {Puppeteer.Page} page - The Page class created from Puppeteer.
 * @param {string} tab - The name of the left-hand navigation tab to use.
 * @returns {Promise<string[]>}
 */
async function getLeftHandDrawerLinks(
    rootNetSuiteSchemaUrl: string,
    page: Puppeteer.Page,
    tab: string,
): Promise<string[]> {
    type EvalFunction = (contentPanel: Element[], folder: string) => string[];

    return page.$$eval<
        string,
        string[],
        EvalFunction
    >(
        `[name="${tab}switch"]`,
        (buttons, url) => buttons.map(button => {
            const onClickString = (button as HTMLButtonElement).onclick?.toString() || '';
            const schemaIndex = onClickString.indexOf('schema');
            const lastSingleQuote = onClickString.lastIndexOf('\'');
            const tailNetSuiteSchemaUrl = onClickString.slice(schemaIndex, lastSingleQuote);
            return `${url}${tailNetSuiteSchemaUrl}`;
        }),
        rootNetSuiteSchemaUrl,
    );
}

/**
 * Gets links to all namespaces for a specific version of NetSuite.
 * @param {Puppeteer.Page} page - The Page class created from Puppeteer.
 * @param {string} rootNetSuiteSchemaUrl - The root NetSuite Schema Browser URL for a specific version of NetSuite.
 * @returns {Promise<string[]>}
 */
async function getNamespaceLinks(
    page: Puppeteer.Page,
    rootNetSuiteSchemaUrl: string,
): Promise<string[]> {
    type EvalFunction = (contentPanel: Element[], folder: string) => string[];

    return page.$$eval<
        string,
        string[],
        EvalFunction
    >(
        '#packagesselect > optgroup > option',
        (options, url) => options.map(option => {
            const outerHtml = option.outerHTML;
            const schemaIndex = outerHtml.indexOf('schema');
            const lastDoubleQuote = outerHtml.lastIndexOf('"');
            const tailNetSuiteSchemaUrl = outerHtml.slice(schemaIndex, lastDoubleQuote);
            return `${url}${tailNetSuiteSchemaUrl}`;
        }),
        rootNetSuiteSchemaUrl,
    );
}

/**
 * Get content from a webpage using the Page class from Puppeteer.
 * @param {Puppeteer.Page} page - The Page class created from Puppeteer.
 * @param {string} rootNetSuiteTypesFolder - The root folder path for a specific version of NetSuite.
 * @returns {Promise<string[]>}
 */
async function getPageContent(
    page: Puppeteer.Page,
    rootNetSuiteTypesFolder: string,
): Promise<string[]> {
    type EvalFunction = (contentPanel: Element, folder: string) => string[];

    return page.$eval<
        string,
        string[],
        EvalFunction
    >(
        '#contentPanel',
        (contentPanel, folder) => {
            const [
                fileName,
                urn,
                ...rows
            ] = (contentPanel as HTMLParagraphElement).innerText
                .split('\n')
                .filter((val: string) => val.trim() !== '');

            // Get filepath from URN
            const urnIndex = urn.indexOf('urn:');
            const endOfUrn = urn.lastIndexOf('com') + 3;
            const urnString = urn.slice(urnIndex + 4, endOfUrn);
            const partialFilePath: string = urnString
                .split('.')
                .reverse()
                .slice(3) // We don't need 'com', 'netsuite', or 'webservices'
                .join('/');
            const filePath = `${folder}${partialFilePath}`;

            return [
                fileName,
                filePath,
                ...rows,
            ];
        },
        rootNetSuiteTypesFolder,
    );
}

/**
 * Get the main NetSuite Schema Browser URL based on the version provided.
 * @param {string} version - The version of NetSuite.
 * @returns {string}
 */
function getRootNetSuiteSchemaUrl(version: string): string {
    return `https://system.na0.netsuite.com/help/helpcenter/en_US/srbrowser/Browser${version}/`;
}

/**
 * Get the requested folder path based on the version provided.
 * @param {string} version - The version of NetSuite.
 * @returns {string}
 */
function getRootNetSuiteTypesFolder(version: string): string {
    return `netsuite-schema-browser-types/src/${version}/`;
}

/**
 * @typedef {Object} FolderContents
 * @property {string[]} files - The files found reading a directory.
 * @property {string[]} folders - The folders found reading a directory.
 */

/**
 * Parses the output from reading a directory into the file and folder names.
 * @param {string[]} contents - The URL this script was generated from.
 * @returns {FolderContents}
 */
function parseFolderContents(contents: string[]): FolderContents {
    const folderContents: FolderContents = {
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

/**
 * Replaces full imports in a script with relative imports.
 * @param {string} filePath - The filepath of the script being modified.
 * @param {string} fileContent - The original content of the script.
 * @returns {string}
 */
function replaceFullImports(filePath: string, fileContent: string): string {
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
                fullImport, // eslint-disable-line @typescript-eslint/no-unused-vars
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
                : [ '.' ];
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

/**
 * Import sort function to be used as `compareFn` parameter to `Array.prototype.sort()`.
 * @param {string} importA - The first import to be compared.
 * @param {string} importB - The second import to be compared.
 * @returns {number}
 */
function sortImports(importA: string, importB: string): number {
    const indexA = importA.indexOf('src/');
    const indexB = importB.indexOf('src/');
    const subA = importA.slice(indexA);
    const subB = importB.slice(indexB);
    return subA.localeCompare(subB);
}

/* eslint-disable @typescript-eslint/no-use-before-define */

/**
 * The main entry into this script.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
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
            logger.info(`Creating 'filePath.ts' for version ${version}...`);
            await createFilePathObjectFile(version);
            logger.info(`Finished creating 'filePath.ts' for version ${version}.`);

            logger.info(`Creating files for version ${version}...`);
            await createFilesForVersion(version);
            logger.info(`Finished creating files for version ${version}.`);
        }
    }

    if (args.createFilesForSingleVersion && args.netsuiteVersion) {
        const { netsuiteVersion: version } = args;

        logger.info(`Creating 'filePath.ts' for version ${version}...`);
        await createFilePathObjectFile(version);
        logger.info(`Finished creating 'filePath.ts' for version ${version}.`);

        logger.info(`Creating files for version ${version}...`);
        await createFilesForVersion(version);
        logger.info(`Finished creating files for version ${version}.`);
    }

    if (args.createFilesForNamespace && args.namespaceLink) {
        const { namespaceLink } = args;

        logger.info(`Creating namespace files from link ${namespaceLink}...`);
        await createFilesForNamespace(namespaceLink);
        logger.info(`Finished creating namespace files from link ${namespaceLink}.`);
    }

    if (args.createSingleFile && args.link) {
        const { link } = args;

        logger.info(`Creating file for page ${link}...`);
        await createSingleFile(link);
        logger.info(`Finished creating file for page ${link}.`);
    }

    if (args.createFilePathObjectFile && args.netsuiteVersion) {
        const { netsuiteVersion: version } = args;

        logger.info(`Creating 'filePath' file for version ${version}...`);
        await createFilePathObjectFile(version);
        logger.info(`Finished creating 'filePath' file for version ${version}.`);
    }

    if (args.createIndexFilesForAllVersions) {
        for (const version of versions) {
            logger.info(`Creating index files for version ${version}...`);
            await createFilePathObjectFile(version);
            logger.info(`Finished creating index files for version ${version}.`);
        }
    }

    if (args.createIndexFilesForSingleVersion && args.netsuiteVersion) {
        const { netsuiteVersion: version } = args;

        logger.info(`Creating index files for version ${version}...`);
        await createIndexFilesForVersion(version);
        logger.info(`Finished creating index files for version ${version}.`);
    }

    if (args.fixImportsForAllVersions) {
        for (const version of versions) {
            logger.info(`Fixing imports for version ${version}...`);
            await fixImportsForVersion(version);
            logger.info(`Finished fixing imports for version ${version}.`);
        }
    }

    if (args.fixImportsForVersion && args.netsuiteVersion) {
        const { netsuiteVersion: version } = args;

        logger.info(`Fixing imports for version ${version}...`);
        await fixImportsForVersion(version);
        logger.info(`Finished fixing imports for version ${version}.`);
    }
}

main()
    .catch(error => {
        logger.error(error);
        process.exit(1);
    });
