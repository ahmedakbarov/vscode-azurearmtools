// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation.  All rights reserved.
// ----------------------------------------------------------------------------
// asdf telemetry?

import * as assert from 'assert';
import * as fse from 'fs-extra';
import * as path from 'path';
import { commands, ConfigurationTarget, MessageItem, TextDocument, Uri, window, workspace } from 'vscode';
import { callWithTelemetryAndErrorHandling, DialogResponses, IActionContext, IAzureQuickPickItem, UserCancelledError } from 'vscode-azureextensionui';
import { configKeys, configPrefix, globalStateKeys, isWin32 } from './constants';
import { DeploymentTemplate } from './DeploymentTemplate';
import { ext } from './extensionVariables';
import { containsParamsSchema } from './schemas';

const readAtMostBytesToFindParamsSchema = 4 * 1024;
const currentMessage = "Current";
const similarFilenameMessage = "Filename matches";
const howToMessage = `You can manually associate a parameter file with this template at any time by clicking "Select Parameter File..." in the status bar or the editor context menu.`;

const _filesToIgnoreThisSession: Set<string> = new Set<string>();

interface IPossibleParamFile {
  uri: Uri;
  friendlyPath: string;
  isCloseNameMatch: boolean;
}

// tslint:disable-next-line: max-func-body-length asdf
export async function selectParameterFile(actionContext: IActionContext, sourceUri: Uri | undefined): Promise<void> {
  if (!sourceUri) {
    sourceUri = window.activeTextEditor?.document.uri;
  }

  if (!sourceUri) {
    await ext.ui.showWarningMessage(`No Azure Resource Manager template file is being edited.`);
    return;
  }

  let templateUri: Uri = sourceUri;

  // Verify it's a template file asdf
  const contents = (await fse.readFile(templateUri.fsPath, { encoding: "utf8" })).toString();
  const template: DeploymentTemplate = new DeploymentTemplate(contents, "Check file is template");
  if (!template.hasArmSchemaUri()) {
    throw new Error(`"${templateUri.fsPath}" does not appear to be an Azure Resource Manager deployment template file.`);
  }

  // Find likely parameter file matches
  let suggestions: IPossibleParamFile[] = await findSuggestedParameterFiles(templateUri);

  // Find the current in that list
  const currentParamUri: Uri | undefined = findMappedParamFileForTemplate(templateUri);
  const currentParamPathNormalized: string | undefined = currentParamUri ? normalizePath(currentParamUri) : undefined;
  let currentParamFile: IPossibleParamFile | undefined = suggestions.find(pf => normalizePath(pf.uri) === currentParamPathNormalized);
  if (currentParamUri && !currentParamFile) {
    // There is a current parameter file, but it wasn't among the list we came up with.  We must add it to the list.
    currentParamFile = { isCloseNameMatch: false, uri: currentParamUri, friendlyPath: getFriendlyPathToParamFile(templateUri, currentParamUri) };
    suggestions = suggestions.concat(currentParamFile);
  }

  // Create initial pick list and sort it
  let pickItems: IAzureQuickPickItem<IPossibleParamFile | undefined>[] = suggestions.map(paramFile => createQuickPickItem(paramFile, currentParamFile, templateUri));
  pickItems.sort((a, b) => {
    const aData = a?.data;
    const bData = a?.data;

    // Close name matches go first
    if (a?.data?.isCloseNameMatch !== b?.data?.isCloseNameMatch) {
      return a?.data?.isCloseNameMatch ? -1 : 1;
    }

    // Otherwise compare filenames
    // tslint:disable-next-line: strict-boolean-expressions
    return (aData?.uri.fsPath || "").localeCompare(bData?.uri.fsPath || "");
  });

  // Add None at top, Browse at bottom
  const none: IAzureQuickPickItem<IPossibleParamFile | undefined> = {
    label: "$(circle-slash) None",
    description: !!currentParamUri ? undefined : currentMessage,
    data: undefined
  };
  const browse: IAzureQuickPickItem<IPossibleParamFile | undefined> = {
    label: '$(file-directory) Browse...',
    data: undefined
  };
  pickItems = [none].concat(pickItems).concat([browse]);

  //asdf
  // // Move the current item (if any) to the very top
  // const currentItem = pickItems.find(pi => pi.data === currentParamFile);
  // if (currentItem) {
  //   pickItems = [currentItem].concat(pickItems.filter(ppf => ppf !== currentItem));
  // }

  // Show the quick pick
  const result: IAzureQuickPickItem<IPossibleParamFile | undefined> = await ext.ui.showQuickPick(
    pickItems,
    {
      canPickMany: false,
      placeHolder: `Select a parameter file to associate with "${path.basename(templateUri.fsPath)}"`,
      suppressPersistence: true
    });

  // Interpret result
  if (result === none) {
    // None

    // Remove the mapping for this file
    await neverAskAgain(templateUri, actionContext);
    await setMappedParamFileForTemplate(templateUri, undefined);
  } else if (result === browse) {
    // Browse...

    const paramsPaths: Uri[] | undefined = await window.showOpenDialog({
      canSelectMany: false,
      defaultUri: templateUri,
      openLabel: "Select Parameter File"
    });
    if (!paramsPaths || paramsPaths.length !== 1) {
      throw new UserCancelledError();
    }
    const selectedParamsPath: Uri = paramsPaths[0];

    if (!await isParameterFile(selectedParamsPath.fsPath)) {
      const selectAnywayResult = await ext.ui.showWarningMessage(
        `"${selectedParamsPath.fsPath}" does not appear to be a valid parameter file. Select it anyway?`,
        { modal: true },
        DialogResponses.yes,
        DialogResponses.no
      );
      if (selectAnywayResult !== DialogResponses.yes) {
        throw new UserCancelledError();
      }
    }

    await neverAskAgain(templateUri, actionContext);

    // Map to the browsed file
    await setMappedParamFileForTemplate(templateUri, selectedParamsPath);
  } else if (result.data === currentParamFile) {
    // Current re-selected

    // Nothing to change
    dontAskAgainThisSession(templateUri, actionContext);
  } else {
    // Item in the list selected

    assert(result.data, "Quick pick item should have had data");
    await neverAskAgain(templateUri, actionContext);
    await setMappedParamFileForTemplate(templateUri, result.data?.uri);
  }
}

/**
 * If the params file is inside the workspace folder, use the path relative to its template file. Otherwise, return the
 * absolute path to the params file. This is intended to make the path most logical to the user.
 */
export function getFriendlyPathToParamFile(templateUri: Uri, paramFileUri: Uri): string {
  const workspaceFolder = workspace.getWorkspaceFolder(paramFileUri);
  if (workspaceFolder) {
    return path.relative(path.dirname(templateUri.fsPath), paramFileUri.fsPath);
  } else {
    return paramFileUri.fsPath;
  }
}

function createQuickPickItem(paramFile: IPossibleParamFile, current: IPossibleParamFile | undefined, templateUri: Uri): IAzureQuickPickItem<IPossibleParamFile> {
  return {
    label: `$(json) ${paramFile.friendlyPath}`,
    data: paramFile,
    description: paramFile === current ? currentMessage :
      paramFile.isCloseNameMatch ? similarFilenameMessage :
        undefined
  };
}

function normalizePath(filePath: Uri | string): string {
  const fsPath: string = typeof filePath === 'string' ? filePath :
    filePath.fsPath;
  let normalizedPath = path.normalize(fsPath);
  if (isWin32) {
    normalizedPath = normalizedPath.toLowerCase();
  }

  return normalizedPath;
}

/**
 * Finds parameter files to suggest for a given template.
 */
export async function findSuggestedParameterFiles(templateUri: Uri): Promise<IPossibleParamFile[]> {
  let paths: IPossibleParamFile[] = [];

  // Current logic is simple: Find all .json/c files in the same folder as the template file
  try {
    const folder = path.dirname(templateUri.fsPath);
    const fileNames: string[] = await fse.readdir(folder);
    for (let paramFileName of fileNames) {
      const fullPath: string = path.join(folder, paramFileName);
      const uri: Uri = Uri.file(fullPath);
      if (await isParameterFile(fullPath)) {
        paths.push({
          uri,
          friendlyPath: getFriendlyPathToParamFile(templateUri, uri),
          isCloseNameMatch: mayBeMatchingParamFile(templateUri.fsPath, fullPath)
        });
      }
    }
  } catch (error) {
    // Ignore
  }

  return paths;
}

async function isParameterFile(filePath: string): Promise<boolean> {
  try {
    if (!hasSupportedParamFileExtension(filePath)) {
      return false;
    }

    if (await doesFileContainString(filePath, containsParamsSchema, readAtMostBytesToFindParamsSchema)) {
      return true;
    }
  } catch (error) {
    // Ignore
  }

  return false;
}

async function doesFileContainString(filePath: string, matches: (fileSubcontents: string) => boolean, maxBytesToRead: number): Promise<boolean> {
  // tslint:disable-next-line: typedef
  return new Promise<boolean>((resolve, reject) => {
    const stream = fse.createReadStream(filePath, { encoding: 'utf8' });

    let content: string = '';
    stream.on('data', (chunk: string) => {
      content += chunk;
      if (containsParamsSchema(content)) {
        stream.close();
        resolve(true);
      }
    });
    stream.on('end', () => {
      resolve(false);
    });
    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Determines if a file is likely a parameter file for the given template file, based on name.
 * Common patterns are:
 *   template.json, template.params.json
 *   template.json, template.parameters.json
 */
export function mayBeMatchingParamFile(templateFileName: string, paramFileName: string): boolean {
  if (!hasSupportedParamFileExtension(paramFileName)) {
    return false;
  }

  const baseTemplateName = removeAllExtensions(path.basename(templateFileName)).toLowerCase();
  const baseParamsName = removeAllExtensions(path.basename(paramFileName)).toLowerCase();

  return baseParamsName.startsWith(baseTemplateName);
}

function removeAllExtensions(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/**
 * Search for potential parameter file matches for the given document, and ask the user if appropriate whether to associate it
 */
export function considerQueryingForParameterFile(document: TextDocument): void {
  // Only deal with saved files, because we don't have an accurate
  //   URI that we can track for unsaved files, and it's a better user experience.
  if (document.uri.scheme !== 'file') {
    return;
  }

  const templateUri = document.uri;
  const templatPath = templateUri.fsPath;
  const alreadyHasParamFile: boolean = !!findMappedParamFileForTemplate(document.uri);

  // tslint:disable-next-line: no-floating-promises Don't wait
  callWithTelemetryAndErrorHandling('queryAddParameterFile', async (actionContext: IActionContext): Promise<void> => {
    actionContext.telemetry.properties.alreadyHasParamFile = String(alreadyHasParamFile);

    if (alreadyHasParamFile) {
      return;
    }

    if (!canAsk(templateUri, actionContext)) {
      return;
    }

    const suggestions = await findSuggestedParameterFiles(document.uri);
    const closeMatches = suggestions.filter(pf => pf.isCloseNameMatch);
    actionContext.telemetry.measurements.closeMatches = closeMatches.length;
    // Take the shortest as the most likely best match
    const closestMatch: IPossibleParamFile | undefined = closeMatches.length > 0 ? closeMatches.sort(pf => -pf.uri.fsPath.length)[0] : undefined;
    if (!closestMatch) {
      // No likely matches, so don't ask
      return;
    }

    const yes: MessageItem = { title: "Yes" };
    const no: MessageItem = { title: "No" };
    const another: MessageItem = { title: "Choose File..." };

    //asdf ask when no template file
    const response = await ext.ui.showWarningMessage(
      `A parameter file "${closestMatch.friendlyPath}" has been detected. Do you want to associate it with template file "${path.basename(templatPath)}"? Having a parameter file association enables additional functionality, such as deeper validation.`,
      yes,
      no,
      another
    );
    actionContext.telemetry.properties.response = response.title;

    switch (response.title) {
      case yes.title:
        await setMappedParamFileForTemplate(templateUri, closestMatch.uri);
        break;
      case no.title:
        // We won't ask again
        await neverAskAgain(templateUri, actionContext);

        // Let them know how to do it manually
        // Don't wait for an answer
        window.showInformationMessage(howToMessage);
        break;
      case another.title:
        await commands.executeCommand("azurerm-vscode-tools.selectParameterFile", templateUri);
        // asdf what if they cancel?  Do we tell them how?  ask again?
        break;
      default:
        assert("considerQueryingForParameterFile: Unexpected response");
        break;
    }
  });
}

function canAsk(templateUri: Uri, actionContext: IActionContext): boolean {
  const checkForMatchingParamFilesSetting: boolean = !!workspace.getConfiguration(configPrefix).get<boolean>(configKeys.checkForMatchingParamFiles);
  actionContext.telemetry.properties.checkForMatchingParamFiles = String(checkForMatchingParamFilesSetting);
  if (!checkForMatchingParamFilesSetting) {
    return false;
  }

  // tslint:disable-next-line: strict-boolean-expressions
  const neverAskFiles: string[] = ext.context.globalState.get<string[]>(globalStateKeys.dontAskAboutParamFiles) || [];
  const key = normalizePath(templateUri);
  if (neverAskFiles.includes(key)) {
    actionContext.telemetry.properties.isInDontAskList = 'true';
    return false;
  }

  let ignoreThisSession = _filesToIgnoreThisSession.has(normalizePath(templateUri));
  if (ignoreThisSession) {
    actionContext.telemetry.properties.ignoreThisSession = 'true';
    return false;
  }

  return true;
}

function dontAskAgainThisSession(templateUri: Uri, actionContext: IActionContext): void {
  _filesToIgnoreThisSession.add(normalizePath(templateUri));
}

async function neverAskAgain(templateUri: Uri, actionContext: IActionContext): Promise<void> {
  // tslint:disable-next-line: strict-boolean-expressions
  const neverAskFiles: string[] = ext.context.globalState.get<string[]>(globalStateKeys.dontAskAboutParamFiles) || [];
  const key: string = normalizePath(templateUri);
  neverAskFiles.push(key);
  await ext.context.globalState.update(globalStateKeys.dontAskAboutParamFiles, neverAskFiles);
}

/**
 * Given a template file, find the parameter file, if any, that the user currently has associated with it
 */
export function findMappedParamFileForTemplate(templateFileUri: Uri): Uri | undefined {
  const paramFiles: { [key: string]: string } | undefined =
    workspace.getConfiguration(configPrefix).get<{ [key: string]: string }>(configKeys.parameterFiles);
  if (typeof paramFiles === "object") {
    const normalizedTemplatePath = normalizePath(templateFileUri.fsPath);
    let paramFile: Uri | undefined;
    for (let fileNameKey of Object.getOwnPropertyNames(paramFiles)) {
      const normalizedFileName: string | undefined = normalizePath(fileNameKey);
      if (normalizedFileName === normalizedTemplatePath) {
        if (typeof paramFiles[fileNameKey] === 'string') {
          // Resolve relative to template file's folder
          let resolvedPath = path.resolve(path.dirname(templateFileUri.fsPath), paramFiles[fileNameKey]);

          // If the user has an entry in both workspace and user settings, vscode combines the two objects,
          //   with workspace settings overriding the user settings.
          // If there are two entries differing only by case, allow the last one to win, because it will be
          //   the workspace setting value
          paramFile = !!resolvedPath ? Uri.file(resolvedPath) : undefined; // asdf what if invalid uri?
        }
      }
    }

    return paramFile;

    // asdf urls?
  }

  return undefined;
}

async function setMappedParamFileForTemplate(templateUri: Uri, paramFileUri: Uri | undefined): Promise<void> {
  const relativeParamFilePath: string | undefined = paramFileUri ? getFriendlyPathToParamFile(templateUri, paramFileUri) : undefined;
  const normalizedTemplatePath = normalizePath(templateUri.fsPath);

  // We only want the values in the user settings
  const map = workspace.getConfiguration(configPrefix).inspect<{ [key: string]: string | undefined }>(configKeys.parameterFiles)?.globalValue;

  if (typeof map !== 'object') {
    return;
  }

  // Copy existing entries that don't match (might be multiple entries with different casing, so can't do simple delete)
  const newMap: { [key: string]: string | undefined } = {};

  for (let templatePath of Object.getOwnPropertyNames(map)) {
    if (normalizePath(templatePath) !== normalizedTemplatePath) {
      newMap[templatePath] = map[templatePath];
    }
  }

  // Add new entry
  if (paramFileUri) {
    newMap[templateUri.fsPath] = relativeParamFilePath;
  }
  /* asdf
       * Will throw error when
     * - Writing a configuration which is not registered.
     * - Writing a configuration to workspace or folder target when no workspace is opened
     * - Writing a configuration to folder target when there is no folder settings
     * - Writing to folder target without passing a resource when getting the configuration (`workspace.getConfiguration(section, resource)`)
     * - Writing a window configuration to folder target
*/
  await workspace.getConfiguration(configPrefix).update(configKeys.parameterFiles, newMap, ConfigurationTarget.Global);
}

function hasSupportedParamFileExtension(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.json' || extension === '.jsonc';
}