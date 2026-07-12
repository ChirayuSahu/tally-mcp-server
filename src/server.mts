import path from 'node:path';
import express from 'express';
import crypto from 'node:crypto';
import dotenv from 'dotenv'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { registerMcpServer } from './mcp.mjs'


const mcpPort = parseInt(process.env.PORT || '3000');
const mcpDomain = process.env.MCP_DOMAIN || 'http://localhost:3000';
const __dirname = import.meta.dirname;

const app = express();
app.use((req, res, next) => {
  if (req.path === '/mcp') {
    return next();
  }
  express.json()(req, res, (err) => {
    if (err) return next(err);
    express.urlencoded({ extended: true })(req, res, next);
  });
});

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] - ${req.ip} - ${req.method} ${req.url}`);
  next();
});
const authPassword = process.env.PASSWORD || 'password';


const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

const checkAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${authPassword}`) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized: Invalid password' },
      id: null
    });
    return;
  }
  next();
};

app.use('/mcp', checkAuth, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    console.log(`[MCP Route] Method: ${req.method}, SessionID: ${sessionId || 'None'}`);
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      console.log(`[MCP Route] Found existing transport for session: ${sessionId}`);
      transport = transports[sessionId];
    } else if (!sessionId) {
      console.log(`[MCP Route] No session ID provided, creating new transport...`);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          console.log(`[MCP Route] Session initialized: ${sid}`);
          transports[sid] = transport;
        },
        allowedHosts: [mcpDomain],
      });

      transport.onclose = () => {
        console.log(`[MCP Route] Transport closed for session: ${transport.sessionId}`);
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      const mcpServer = await registerMcpServer();
      await mcpServer.connect(transport);
      console.log(`[MCP Route] New transport connected and server registered.`);
    } else {
      console.error(`[MCP Route] Invalid session ID provided: ${sessionId}`);
      res.status(400).send("Invalid session ID");
      return;
    }

    console.log(`[MCP Route] Handling request...`);
    await transport.handleRequest(req, res);
    console.log(`[MCP Route] Request handled successfully.`);
  } catch (error) {
    console.error('[MCP Route] Transport error:', error);
    next(error);
  }
});


// Start MCP Server listener
const httpServer = app.listen(mcpPort, () => console.log(`MCP Server started on port ${mcpPort}`));

// Keep this above the reverse proxy's idle/keep-alive timeout (e.g. IIS ARR). Otherwise Node
// can close a pooled connection right as the proxy reuses it, hanging the next request
// (e.g. notifications/initialized right after initialize) until the client's own timeout fires.
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;