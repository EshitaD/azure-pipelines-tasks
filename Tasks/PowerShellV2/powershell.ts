import fs = require('fs');
import path = require('path');
import os = require('os');
import tl = require('azure-pipelines-task-lib/task');
import tr = require('azure-pipelines-task-lib/toolrunner');
import { sanitizeScriptArgs } from 'azure-pipelines-tasks-utility-common/argsSanitizer';
var uuidV4 = require('uuid/v4');

function getActionPreference(vstsInputName: string, defaultAction: string = 'Default', validActions: string[] = ['Default', 'Stop', 'Continue', 'SilentlyContinue']) {
    let result: string = tl.getInput(vstsInputName, false) || defaultAction;

    if (validActions.map(actionPreference => actionPreference.toUpperCase()).indexOf(result.toUpperCase()) < 0) {
        throw new Error(tl.loc('JS_InvalidActionPreference', vstsInputName, result, validActions.join(', ')))
    }

    return result
}

async function run() {
    try {
        tl.setResourcePath(path.join(__dirname, 'task.json'));

        // Get inputs.
        let input_errorActionPreference: string = getActionPreference('errorActionPreference', 'Stop');
        let input_warningPreference: string = getActionPreference('warningPreference', 'Default');
        let input_informationPreference: string = getActionPreference('informationPreference', 'Default');
        let input_verbosePreference: string = getActionPreference('verbosePreference', 'Default');
        let input_debugPreference: string = getActionPreference('debugPreference', 'Default');
        let input_progressPreference: string = getActionPreference('progressPreference', 'SilentlyContinue');

        let input_showWarnings = tl.getBoolInput('showWarnings', false);
        let input_failOnStderr = tl.getBoolInput('failOnStderr', false);
        let input_ignoreLASTEXITCODE = tl.getBoolInput('ignoreLASTEXITCODE', false);
        let input_workingDirectory = tl.getPathInput('workingDirectory', /*required*/ true, /*check*/ true);
        let input_filePath: string;
        let input_arguments: string;
        let input_script: string;
        let input_targetType: string = tl.getInput('targetType') || '';
        if (input_targetType.toUpperCase() == 'FILEPATH') {
            input_filePath = tl.getPathInput('filePath', /*required*/ true);
            if (!tl.stats(input_filePath).isFile() || !input_filePath.toUpperCase().match(/\.PS1$/)) {
                throw new Error(tl.loc('JS_InvalidFilePath', input_filePath));
            }

            input_arguments = tl.getInput('arguments') || '';
        }
        else if (input_targetType.toUpperCase() == 'INLINE') {
            input_script = tl.getInput('script', false) || '';
        }
        else {
            throw new Error(tl.loc('JS_InvalidTargetType', input_targetType));
        }
        const input_runScriptInSeparateScope = tl.getBoolInput('runScriptInSeparateScope');

        // Generate the script contents.
        console.log(tl.loc('GeneratingScript'));
        let contents: string[] = [];
        if (input_errorActionPreference.toUpperCase() != 'DEFAULT') {
            contents.push(`$ErrorActionPreference = '${input_errorActionPreference}'`);
        }
        if (input_warningPreference.toUpperCase() != 'DEFAULT') {
            contents.push(`$WarningPreference = '${input_warningPreference}'`);
        }
        if (input_informationPreference.toUpperCase() != 'DEFAULT') {
            contents.push(`$InformationPreference = '${input_informationPreference}'`);
        }
        if (input_verbosePreference.toUpperCase() != 'DEFAULT') {
            contents.push(`$VerbosePreference = '${input_verbosePreference}'`);
        }
        if (input_debugPreference.toUpperCase() != 'DEFAULT') {
            contents.push(`$DebugPreference = '${input_debugPreference}'`);
        }
        if (input_progressPreference.toUpperCase() != 'DEFAULT') {
            contents.push(`$ProgressPreference = '${input_progressPreference}'`);
        }

        let script = '';
        if (input_targetType.toUpperCase() == 'FILEPATH') {
            let resultArgs = input_arguments;

            const featureFlags = {
                audit: tl.getBoolFeatureFlag('AZP_75787_ENABLE_NEW_LOGIC_LOG'),
                activate: tl.getBoolFeatureFlag('AZP_75787_ENABLE_NEW_LOGIC'),
                telemetry: tl.getBoolFeatureFlag('AZP_75787_ENABLE_COLLECT')
            };

            if (featureFlags.activate || featureFlags.activate || featureFlags.telemetry) {
                const sanitizedArgs = sanitizeScriptArgs(
                    input_arguments,
                    {
                        argsSplitSymbols: '``',
                        warningLocSymbol: 'JS_SanitizerOutput',
                        telemetryFeature: 'PowerShellV2',
                        saniziteRegExp: /(?<!`)([^a-zA-Z0-9\\` _'"\-=\/:\.])/g
                    }
                );
                if (featureFlags.activate) {
                    resultArgs = sanitizedArgs;
                }
            }

            script = `. '${input_filePath.replace(/'/g, "''")}' ${resultArgs}`.trim();
        } else {
            script = `${input_script}`;
        }
        if (input_showWarnings) {
            script = `
                $warnings = New-Object System.Collections.ObjectModel.ObservableCollection[System.Management.Automation.WarningRecord];
                Register-ObjectEvent -InputObject $warnings -EventName CollectionChanged -Action {
                    if($Event.SourceEventArgs.Action -like "Add"){
                        $Event.SourceEventArgs.NewItems | ForEach-Object {
                            Write-Host "##vso[task.logissue type=warning;]$_";
                        }
                    }
                };
                Invoke-Command {${script}} -WarningVariable +warnings;
            `;
        }
        contents.push(script);
        // log with detail to avoid a warning output.
        tl.logDetail(uuidV4(), tl.loc('JS_FormattedCommand', script), null, 'command', 'command', 0);

        if (!input_ignoreLASTEXITCODE) {
            contents.push(`if (!(Test-Path -LiteralPath variable:\LASTEXITCODE)) {`);
            contents.push(`    Write-Host '##vso[task.debug]$LASTEXITCODE is not set.'`);
            contents.push(`} else {`);
            contents.push(`    Write-Host ('##vso[task.debug]$LASTEXITCODE: {0}' -f $LASTEXITCODE)`);
            contents.push(`    exit $LASTEXITCODE`);
            contents.push(`}`);
        }

        // Write the script to disk.
        tl.assertAgent('2.115.0');
        let tempDirectory = tl.getVariable('agent.tempDirectory');
        tl.checkPath(tempDirectory, `${tempDirectory} (agent.tempDirectory)`);
        let filePath = path.join(tempDirectory, uuidV4() + '.ps1');
        fs.writeFileSync(
            filePath,
            '\ufeff' + contents.join(os.EOL), // Prepend the Unicode BOM character.
            { encoding: 'utf8' });            // Since UTF8 encoding is specified, node will
        //                                    // encode the BOM into its UTF8 binary sequence.

        // Run the script.
        //
        // Note, prefer "pwsh" over "powershell". At some point we can remove support for "powershell".
        //
        // Note, use "-Command" instead of "-File" to match the Windows implementation. Refer to
        // comment on Windows implementation for an explanation why "-Command" is preferred.
        console.log('========================== Starting Command Output ===========================');

        const executionOperator = input_runScriptInSeparateScope ? '&' : '.';
        let powershell = tl.tool(tl.which('pwsh') || tl.which('powershell') || tl.which('pwsh', true))
            .arg('-NoLogo')
            .arg('-NoProfile')
            .arg('-NonInteractive')
            .arg('-Command')
            .arg(`${executionOperator} '${filePath.replace(/'/g, "''")}'`);
        let options = <tr.IExecOptions>{
            cwd: input_workingDirectory,
            failOnStdErr: false,
            errStream: process.stdout, // Direct all output to STDOUT, otherwise the output may appear out
            outStream: process.stdout, // of order since Node buffers it's own STDOUT but not STDERR.
            ignoreReturnCode: true
        };

        // Listen for stderr.
        let stderrFailure = false;
        const aggregatedStderr: string[] = [];
        if (input_failOnStderr) {
            powershell.on('stderr', (data: Buffer) => {
                stderrFailure = true;
                aggregatedStderr.push(data.toString('utf8'));
            });
        }

        // Run bash.
        let exitCode: number = await powershell.exec(options);
        // Fail on exit code.
        if (exitCode !== 0) {
            tl.setResult(tl.TaskResult.Failed, tl.loc('JS_ExitCode', exitCode));
        }

        // Fail on stderr.
        if (stderrFailure) {
            tl.setResult(tl.TaskResult.Failed, tl.loc('JS_Stderr'));
            aggregatedStderr.forEach((err: string) => {
                tl.error(err);
            });
        }
    }
    catch (err) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'run() failed');
    }
}

run();
