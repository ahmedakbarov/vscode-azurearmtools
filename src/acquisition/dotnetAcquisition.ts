/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseError } from 'vscode-azureextensionui';
import { assetsPath } from '../constants';
import { ext } from '../extensionVariables';
import { DotnetCoreAcquisitionWorker } from './DotnetCoreAcquisitionWorker';
import { DotnetCoreDependencyInstaller } from './DotnetCoreDependencyInstaller';
import { EventStream } from './EventStream';
import { IEventStreamObserver } from './IEventStreamObserver';
import { OutputChannelObserver } from './OutputChannelObserver';
import { StatusBarObserver } from './StatusBarObserver';

let acquisitionWorker: DotnetCoreAcquisitionWorker;
let initialized = false;

function initializeDotnetAcquire(): void { //asdf no reg commands, asdf no new output channel
    if (initialized) {
        return;
    }

    console.log("Initializing dotnet acquire...");

    let context = ext.context;
    let parentExtensionId = ext.extensionId;
    let scriptsPath = path.join(assetsPath, 'scripts');

    const extension = vscode.extensions.getExtension(parentExtensionId);

    if (!extension) {
        throw new Error(`Could not resolve dotnet acquisition extension '${parentExtensionId}' location`);
    }

    //const outputChannel = vscode.window.createOutputChannel('.NET Core Tooling');
    const eventStreamObservers: IEventStreamObserver[] =
        [
            new StatusBarObserver(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, Number.MIN_VALUE)),
            new OutputChannelObserver(ext.outputChannel),
        ];
    const eventStream = new EventStream();

    for (const observer of eventStreamObservers) {
        eventStream.subscribe(event => observer.post(event));
    }

    if (!fs.existsSync(context.globalStoragePath)) { //asdf?
        fs.mkdirSync(context.globalStoragePath);
    }
    acquisitionWorker = new DotnetCoreAcquisitionWorker(
        context.globalStoragePath,
        context.globalState,
        scriptsPath,
        eventStream);
}

export async function dotnetAcquire(version: string): Promise<string> {
    initializeDotnetAcquire();

    if (!version || version === 'latest') {
        throw new Error(`Cannot acquire .NET Core version "${version}". Please provide a valid version.`);
    }
    return acquisitionWorker.acquire(version);
}

export async function ensureDotnetDependencies(dotnetPath: string, args: string[]): Promise<void> {
    initializeDotnetAcquire();

    if (os.platform() !== 'linux') {
        // We can't handle installing dependencies for anything other than Linux
        return;
    }

    const result = cp.spawnSync(dotnetPath, args);
    const installer = new DotnetCoreDependencyInstaller();
    if (installer.signalIndicatesMissingLinuxDependencies(result.signal)) {
        await installer.promptLinuxDependencyInstall('Failed to run .NET tooling.');
    }

    // TODO: Handle cases where .NET failed for unknown reasons.
}

export async function uninstallDotnet(): Promise<void> {
    initializeDotnetAcquire();

    ext.outputChannel.appendLine("Uninstalling dotnet core for extension...");
    try {
        await acquisitionWorker.uninstallAll();
    }
    catch (error) {
        let message = parseError(error).message;
        if (message.includes('EPERM')) {
            error = new Error(`dotnet core may be in use, please restart VS Code and try again. ${message}`);
        }

        throw error;
    }

    ext.outputChannel.appendLine("Done.");
}
