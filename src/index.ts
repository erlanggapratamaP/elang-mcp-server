import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Octokit } from "@octokit/rest";

// Interface definitions for GitHub MCP
interface FileItem {
  name: string;
  path: string;
  type: 'file';
  size: number;
  download_url: string | null;
}

interface DirectoryItem {
  name: string;
  path: string;
  type: 'directory';
  children: (FileItem | DirectoryItem)[];
}

interface FileWithContent {
  path: string;
  content: string | null;
}

interface RepositoryResponse {
  repository: {
    owner: string;
    repo: string;
    structure: (FileItem | DirectoryItem)[];
  };
  files?: FileWithContent[];
}

interface FileResponse {
  path: string;
  content: string | null;
}

// SSE Client Management
interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
}

let sseClients: SSEClient[] = [];

// Function to validate GitHub token
function validateGitHubToken(token: string | undefined): boolean {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return false;
  }
  return true;
}

// Handler to get repo structure 
async function getRepositoryStructure(
  octokit: Octokit, 
  owner: string, 
  repo: string, 
  path: string = ''
): Promise<(FileItem | DirectoryItem)[]> {
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path,
    });

    if (Array.isArray(response.data)) {
      const items: (FileItem | DirectoryItem)[] = [];
      for (const item of response.data) {
        if (item.type === 'dir') {
          const subItems = await getRepositoryStructure(octokit, owner, repo, item.path);
          items.push({
            name: item.name,
            path: item.path,
            type: 'directory',
            children: subItems,
          });
        } else if (item.type === 'file') {
          items.push({
            name: item.name,
            path: item.path,
            type: 'file',
            size: item.size,
            download_url: item.download_url,
          });
        }
      }
      return items;
    } else {
      return [{
        name: response.data.name,
        path: response.data.path,
        type: 'file',
        size: response.data.size,
        download_url: response.data.download_url,
      }];
    }
  } catch (error) {
    console.error('Error getting repository structure:', error);
    return [];
  }
}

// Handler to get file content
async function getFileContent(
  octokit: Octokit, 
  owner: string, 
  repo: string, 
  path: string
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({
      owner,
      repo,
      path,
    });

    // GitHub API to return into base64
    if ('content' in response.data) {
      const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
      return content;
    }
    return null;
  } catch (error) {
    console.error('Error getting file content:', error);
    return null;
  }
}

// SSE Helper Functions
function sendSSEMessage(clientId: string | null, event: string, data: any) {
  if (clientId) {
    // Send to specific client
    const client = sseClients.find(c => c.id === clientId);
    if (client) {
      client.controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  } else {
    // Broadcast to all clients
    sseClients.forEach(client => {
      client.controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
  }
}

function keepAlive() {
  // Send a comment to keep the connection alive every 30 seconds
  setInterval(() => {
    sseClients.forEach(client => {
      client.controller.enqueue(`: keep-alive\n\n`);
    });
  }, 30000);
}

// Start keepAlive function - THIS WAS MISSING
let keepAliveInterval: any = null;

// Define our MCP agent with GitHub tools
export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "github-mcp",
    version: "0.0.1",
  });  

  async init() {
    // Register GitHub repository tool
    this.server.tool(
      "get_repository_structure",
      { 
        token: z.string().min(1),
        owner: z.string().min(1),
        repo: z.string().min(1),
        includeContent: z.boolean().optional().default(false),
        extensions: z.array(z.string()).optional().default([])
      },
      async ({ token, owner, repo, includeContent, extensions }) => {
        if (!validateGitHubToken(token)) {
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ error: "Invalid GitHub token" })
            }],
          };
        }

        try {
          // Notify SSE clients that a repository fetch has started
          sendSSEMessage(null, 'repo_fetch_started', {
            owner,
            repo,
            timestamp: new Date().toISOString()
          });

          const octokit = new Octokit({ auth: token });
          const structure = await getRepositoryStructure(octokit, owner, repo);
          
          let response: RepositoryResponse = {
            repository: {
              owner,
              repo,
              structure
            }
          };
          
          // If includeContent is true, get content for files with specified extensions
          if (includeContent && extensions.length > 0) {
            const filesWithContent: FileWithContent[] = [];
            
            const processItems = async (items: (FileItem | DirectoryItem)[]) => {
              for (const item of items) {
                if (item.type === 'file') {
                  const fileExt = item.name.split('.').pop()?.toLowerCase() || '';
                  if (extensions.includes(fileExt) || extensions.includes('*')) {
                    // Notify SSE clients about file fetch
                    sendSSEMessage(null, 'file_fetch_started', {
                      path: item.path,
                      timestamp: new Date().toISOString()
                    });
                    
                    const content = await getFileContent(octokit, owner, repo, item.path);
                    
                    // Notify SSE clients about file fetch completion
                    sendSSEMessage(null, 'file_fetch_completed', {
                      path: item.path,
                      timestamp: new Date().toISOString(),
                      success: content !== null
                    });
                    
                    filesWithContent.push({
                      path: item.path,
                      content: content
                    });
                  }
                } else if (item.type === 'directory' && item.children) {
                  await processItems(item.children);
                }
              }
            };
            
            await processItems(structure);
            response.files = filesWithContent;
          }
          
          // Notify SSE clients that repository fetch is complete
          sendSSEMessage(null, 'repo_fetch_completed', {
            owner,
            repo,
            timestamp: new Date().toISOString(),
            fileCount: response.files?.length || 0
          });
          
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify(response)
            }],
          };
        } catch (error: any) {
          // Notify SSE clients about the error
          sendSSEMessage(null, 'repo_fetch_error', {
            owner,
            repo,
            timestamp: new Date().toISOString(),
            error: error.message
          });
          
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ 
                error: "Error processing repository request", 
                details: error.message 
              })
            }],
          };
        }
      }
    );

    // Register GitHub file content tool
    this.server.tool(
      "get_file_content",
      { 
        token: z.string().min(1),
        owner: z.string().min(1),
        repo: z.string().min(1),
        path: z.string().min(1)
      },
      async ({ token, owner, repo, path }) => {
        if (!validateGitHubToken(token)) {
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ error: "Invalid GitHub token" })
            }],
          };
        }

        try {
          // Notify SSE clients that a file fetch has started
          sendSSEMessage(null, 'file_fetch_started', {
            path,
            owner,
            repo,
            timestamp: new Date().toISOString()
          });

          const octokit = new Octokit({ auth: token });
          const content = await getFileContent(octokit, owner, repo, path);
          
          if (content === null) {
            // Notify SSE clients about the error
            sendSSEMessage(null, 'file_fetch_error', {
              path,
              owner,
              repo,
              timestamp: new Date().toISOString(),
              error: 'File not found or content could not be retrieved'
            });
            
            return {
              content: [{ 
                type: "text", 
                text: JSON.stringify({ 
                  error: "File not found or content could not be retrieved" 
                })
              }],
            };
          }
          
          const response: FileResponse = {
            path,
            content
          };
          
          // Notify SSE clients that file fetch is complete
          sendSSEMessage(null, 'file_fetch_completed', {
            path,
            owner,
            repo,
            timestamp: new Date().toISOString(),
            success: true
          });
          
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify(response)
            }],
          };
        } catch (error: any) {
          // Notify SSE clients about the error
          sendSSEMessage(null, 'file_fetch_error', {
            path,
            owner,
            repo,
            timestamp: new Date().toISOString(),
            error: error.message
          });
          
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify({ 
                error: "Error processing file request", 
                details: error.message 
              })
            }],
          };
        }
      }
    );
  }
}

// Serve the worker
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// @ts-ignore
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			// @ts-ignore
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};