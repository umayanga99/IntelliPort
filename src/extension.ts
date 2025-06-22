import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import axios from 'axios';

const execAsync = promisify(exec);

// const BACKPORT_API   = ;
const TENSORFLOW_REPO= 'https://api.github.com/repos/tensorflow/tensorflow';

/*──────────────────────────────────────────────────────────────*/
/* 1.  GitHub token helpers                                     */
/*──────────────────────────────────────────────────────────────*/
async function getGitHubToken(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  return ctx.globalState.get<string>('githubToken');
}

async function setGitHubToken(ctx: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    prompt: 'Enter your GitHub Personal Access Token',
    placeHolder: 'github …',
    password: true,
    ignoreFocusOut: true
  });
  if (token) {
    await ctx.globalState.update('githubToken', token);
    vscode.window.showInformationMessage('GitHub token saved.');
  }
}

/*──────────────────────────────────────────────────────────────*/
/* 2.  Fetch all tags (pagination)                              */
/*──────────────────────────────────────────────────────────────*/
async function fetchTags(token: string): Promise<string[]> {
  const tags: string[] = [];
  for (let page = 1; ; page++) {
    const url = `${TENSORFLOW_REPO}/tags?per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    tags.push(...data.map((t: any) => t.name));
  }
  return tags;
}

/*──────────────────────────────────────────────────────────────*/
/* 3.  Git checkout helper (handles “dubious ownership”)        */
/*──────────────────────────────────────────────────────────────*/
async function checkoutTag(tag: string) {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) throw new Error('Open a workspace folder first');

  try {
    await execAsync('git fetch --tags', { cwd: ws });
    await execAsync(`git checkout ${tag}`, { cwd: ws });
    vscode.window.showInformationMessage(`Checked out tag "${tag}"`);
  } catch (err: any) {
    const msg = err?.stderr ?? err?.message;
    if (msg?.includes('dubious ownership')) {
      const ok = await vscode.window.showWarningMessage(
        'Git reports “dubious ownership”. Add this repo to safe.directory and retry?',
        { modal: true }, 'Add & Retry'
      );
      if (ok === 'Add & Retry') {
        await execAsync(`git config --global --add safe.directory "${ws}"`);
        await execAsync(`git checkout ${tag}`, { cwd: ws });
        vscode.window.showInformationMessage(
          `safe.directory added and checked out "${tag}".`
        );
        return;
      }
    }
    throw new Error(`Git checkout failed: ${msg}`);
  }
}

/*──────────────────────────────────────────────────────────────*/
/* 4.  Replace numeric line‑range with patch                    */
/*──────────────────────────────────────────────────────────────*/
async function modifyFileWithPatch(
  absPath: string,
  startLine: number,
  endLine:   number,
  patch:     string
) {
  const raw   = await fs.readFile(absPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  if (startLine <= 0 || endLine > lines.length || startLine > endLine) {
    throw new Error('Invalid line range');
  }

  const indent =
    ' '.repeat(lines[startLine - 1].length - lines[startLine - 1].trimStart().length);

  const indentedPatch = patch
    .split(/\r?\n/)
    .map(l => indent + l)
    .join('\n');

  const updated = [
    ...lines.slice(0, startLine - 1),
    indentedPatch,
    ...lines.slice(endLine)
  ].join('\n');

  await fs.writeFile(absPath, updated, 'utf8');
}

/*──────────────────────────────────────────────────────────────*/
/* 4.1.  API CALL                 */
/*──────────────────────────────────────────────────────────────*/
interface BackportRequest {
    commitHash: string;
    targetVersion: string;
}

interface PatchResponse {
    filePath: string;
    startLine: number;
    endLine: number;
    patch: string;
}

async function callPatchApi(request: BackportRequest): Promise<PatchResponse> {
    const url = "https://7834-192-248-14-69.ngrok-free.app/run";
    
    try {
        const response = await axios.post<PatchResponse>(url, request, {
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true',
                'User-Agent': 'VSCode-Extension'
            }
        });
        
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Axios error:', error.response?.data || error.message);
            throw new Error(`API responded ${error.response?.status}: ${error.response?.data || error.message}`);
        } else {
            console.error('Error:', error);
            throw error;
        }
    }
}

/*──────────────────────────────────────────────────────────────*/
/* 5.  Main backport command                                    */
/*──────────────────────────────────────────────────────────────*/
async function backportToCommand(ctx: vscode.ExtensionContext) {
  /* token check */
  const token = await getGitHubToken(ctx);
  if (!token) {
    vscode.window.showErrorMessage(
      'GitHub token not set. Run “Set GitHub Token…” first.'
    );
    return;
  }

  /* commit hash */
  const commitHash = await vscode.window.showInputBox({
    placeHolder: 'Commit SHA to backport',
    prompt: 'Full or short SHA'
  });
  if (!commitHash) return;

  /* tag list */
  const tag = await vscode.window.showQuickPick(await fetchTags(token), {
    placeHolder: 'Select the target tag'
  });
  if (!tag) return;

  /* checkout */
  try { await checkoutTag(tag); }
  catch (e) { vscode.window.showErrorMessage(String(e)); return; }

  /* call API */
  let patch: PatchResponse;
  try {
    const request: BackportRequest = {
        commitHash: commitHash,
        targetVersion: tag
    };

    vscode.window.showInformationMessage('Calling backport API...');
    patch = await callPatchApi(request);
    vscode.window.showInformationMessage('API call successful!');
    console.log('Patch received:', patch);
    
  } catch (e) {
    console.error('API call failed:', e);
    
    // Fallback to test patch for development
    const useTestPatch = await vscode.window.showWarningMessage(
      'Backend API is not available. Use test patch for demonstration?',
      { modal: true }, 'Use Test Patch', 'Cancel'
    );
    
    if (useTestPatch === 'Use Test Patch') {
      patch = {
        filePath: 'tensorflow/cc/tools/freeze_saved_model_test.cc',
        startLine: 16,
        endLine: 17,
        patch: `void ExampleFunction() {
  // This is the updated implementation
  int x = 42;
  printf("%d", x);
}`.trim()
      };
      vscode.window.showInformationMessage('Using test patch for demonstration');
    } else {
      return;
    }
  }

  

  /* apply patch */
  try {
    const abs = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      patch.filePath
    ).fsPath;
    await modifyFileWithPatch(abs, patch.startLine, patch.endLine, patch.patch);
    vscode.window.showInformationMessage(`Patched ${patch.filePath}`);
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to patch ${patch.filePath}: ${e}`);
  }
}

/*──────────────────────────────────────────────────────────────*/
/* 6.  Register commands                                        */
/*──────────────────────────────────────────────────────────────*/
export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'my-backport-extension.backportTo',
      () => backportToCommand(ctx)
    )
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'my-backport-extension.setGitHubToken',
      () => setGitHubToken(ctx)
    )
  );
}

export function deactivate() {}
