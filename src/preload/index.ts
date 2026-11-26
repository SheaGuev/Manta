import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channel, type MantaApi, type FilesChanged, type LanguageServerStatus, type TerminalInfo, type ThreadEvent, type ThreadInfo } from '../shared/ipc'

/** Identifies this page load to main, so a reloaded window's language server clients get fresh servers. */
const LOAD_ID = crypto.randomUUID()

const api: MantaApi = {
  listProjects: () => ipcRenderer.invoke(Channel.listProjects),
  addProject: (kind) => ipcRenderer.invoke(Channel.addProject, kind),
  removeProject: (root) => ipcRenderer.invoke(Channel.removeProject, root),
  listWorktrees: (projectRoot) => ipcRenderer.invoke(Channel.listWorktrees, projectRoot),
  createWorktree: (projectRoot, name) => ipcRenderer.invoke(Channel.createWorktree, projectRoot, name),
  removeWorktree: (projectRoot, worktreePath) => ipcRenderer.invoke(Channel.removeWorktree, projectRoot, worktreePath),
  listFiles: (root, scope) => ipcRenderer.invoke(Channel.listFiles, root, scope),
  changes: (root) => ipcRenderer.invoke(Channel.changes, root),
  fileAtHead: (root, relPath) => ipcRenderer.invoke(Channel.fileAtHead, root, relPath),
  fileAt: (root, sha, relPath) => ipcRenderer.invoke(Channel.fileAt, root, sha, relPath),
  branch: (root, base) => ipcRenderer.invoke(Channel.branch, root, base),
  branches: (root) => ipcRenderer.invoke(Channel.branches, root),
  commitFiles: (root, sha) => ipcRenderer.invoke(Channel.commitFiles, root, sha),
  repoStatus: (root) => ipcRenderer.invoke(Channel.repoStatus, root),
  searchContent: (root, query) => ipcRenderer.invoke(Channel.searchContent, root, query),
  createFile: (root, relPath) => ipcRenderer.invoke(Channel.createFile, root, relPath),
  createFolder: (root, relPath) => ipcRenderer.invoke(Channel.createFolder, root, relPath),
  deletePath: (root, relPath) => ipcRenderer.invoke(Channel.deletePath, root, relPath),
  openDoc: (root, relPath) => ipcRenderer.invoke(Channel.openDoc, root, relPath),
  createDoc: (root, relPath) => ipcRenderer.invoke(Channel.createDoc, root, relPath),
  pushUpdate: (root, relPath, update) => ipcRenderer.send(Channel.pushUpdate, root, relPath, update),
  saveFile: (root, relPath) => ipcRenderer.invoke(Channel.saveFile, root, relPath),
  formatFile: (root, relPath) => ipcRenderer.invoke(Channel.formatFile, root, relPath),
  revealDoc: (root, relPath) => ipcRenderer.invoke(Channel.revealDoc, root, relPath),
  commit: (root, message, scope) => ipcRenderer.invoke(Channel.commit, root, message, scope),
  stage: (root, paths) => ipcRenderer.invoke(Channel.stage, root, paths),
  unstage: (root, paths) => ipcRenderer.invoke(Channel.unstage, root, paths),
  discardChanges: (root, paths) => ipcRenderer.invoke(Channel.discardChanges, root, paths),
  pull: (root) => ipcRenderer.invoke(Channel.pull, root),
  push: (root) => ipcRenderer.invoke(Channel.push, root),
  createThread: (root, relPath, offset, title) => ipcRenderer.invoke(Channel.createThread, root, relPath, offset, title),
  listThreads: (root, relPath) => ipcRenderer.invoke(Channel.listThreads, root, relPath),
  createSubthread: (root, relPath, parentId, title) => ipcRenderer.invoke(Channel.createSubthread, root, relPath, parentId, title),
  listSubthreads: (root, relPath, parentId) => ipcRenderer.invoke(Channel.listSubthreads, root, relPath, parentId),
  getThread: (root, relPath, id) => ipcRenderer.invoke(Channel.getThread, root, relPath, id),
  setThreadStatus: (root, relPath, id, status) => ipcRenderer.invoke(Channel.setThreadStatus, root, relPath, id, status),
  threadProposal: (root, relPath, id) => ipcRenderer.invoke(Channel.threadProposal, root, relPath, id),
  threadTranscript: (root, id) => ipcRenderer.invoke(Channel.threadTranscript, root, id),
  approveThread: (root, relPath, id) => ipcRenderer.invoke(Channel.approveThread, root, relPath, id),
  threadLanded: (root, relPath, id) => ipcRenderer.invoke(Channel.threadLanded, root, relPath, id),
  dismissThreadChanges: (root, relPath, id) => ipcRenderer.invoke(Channel.dismissThreadChanges, root, relPath, id),
  sendThreadMessage: (root, relPath, id, text) => ipcRenderer.invoke(Channel.sendThreadMessage, root, relPath, id, text),
  cancelThreadTurn: (root, id) => ipcRenderer.invoke(Channel.cancelThreadTurn, root, id),
  answerThreadPermission: (root, threadId, requestId, decision) =>
    ipcRenderer.invoke(Channel.answerThreadPermission, root, threadId, requestId, decision),
  listTerminals: () => ipcRenderer.invoke(Channel.listTerminals),
  startImplementation: (request) => ipcRenderer.invoke(Channel.startImplementation, request),
  openImplementationSession: (docsRoot, doc, id, cols, rows) =>
    ipcRenderer.invoke(Channel.openImplementationSession, docsRoot, doc, id, cols, rows),
  checkImplementation: (docsRoot, doc, id) => ipcRenderer.invoke(Channel.checkImplementation, docsRoot, doc, id),
  createTerminal: (root, kind, cols, rows) => ipcRenderer.invoke(Channel.createTerminal, root, kind, cols, rows),
  restartTerminal: (id, cols, rows) => ipcRenderer.invoke(Channel.restartTerminal, id, cols, rows),
  closeTerminal: (id) => ipcRenderer.invoke(Channel.closeTerminal, id),
  renameTerminal: (id, title) => ipcRenderer.invoke(Channel.renameTerminal, id, title),
  terminalSnapshot: (id) => ipcRenderer.invoke(Channel.terminalSnapshot, id),
  writeTerminal: (id, data) => ipcRenderer.send(Channel.writeTerminal, id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send(Channel.resizeTerminal, id, cols, rows),
  onTerminalData: (listener) => {
    const handler = (_e: IpcRendererEvent, id: string, data: string, seq: number): void => listener(id, data, seq)
    ipcRenderer.on(Channel.terminalData, handler)
    return () => ipcRenderer.off(Channel.terminalData, handler)
  },
  onTerminalChanged: (listener) => {
    const handler = (_e: IpcRendererEvent, info: TerminalInfo): void => listener(info)
    ipcRenderer.on(Channel.terminalChanged, handler)
    return () => ipcRenderer.off(Channel.terminalChanged, handler)
  },
  onCloseTab: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(Channel.closeTab, handler)
    return () => ipcRenderer.off(Channel.closeTab, handler)
  },
  onNavigate: (listener) => {
    const handler = (_e: IpcRendererEvent, direction: unknown): void => {
      if (direction === 'back' || direction === 'forward') listener(direction)
    }
    ipcRenderer.on(Channel.navigate, handler)
    return () => ipcRenderer.off(Channel.navigate, handler)
  },
  onDocProposed: (listener) => {
    const handler = (_e: IpcRendererEvent, docsRoot: string, thread: ThreadInfo): void => listener(docsRoot, thread)
    ipcRenderer.on(Channel.docProposed, handler)
    return () => ipcRenderer.off(Channel.docProposed, handler)
  },
  onTerminalRemoved: (listener) => {
    const handler = (_e: IpcRendererEvent, id: string): void => listener(id)
    ipcRenderer.on(Channel.terminalRemoved, handler)
    return () => ipcRenderer.off(Channel.terminalRemoved, handler)
  },
  listMaps: (docsRoot) => ipcRenderer.invoke(Channel.listMaps, docsRoot),
  getMap: (docsRoot, id) => ipcRenderer.invoke(Channel.getMap, docsRoot, id),
  visitMap: (docsRoot, id) => ipcRenderer.invoke(Channel.visitMap, docsRoot, id),
  markMapSeen: (docsRoot, id) => ipcRenderer.invoke(Channel.markMapSeen, docsRoot, id),
  createMap: (docsRoot, input) => ipcRenderer.invoke(Channel.createMap, docsRoot, input),
  updateMap: (docsRoot, id, settings) => ipcRenderer.invoke(Channel.updateMap, docsRoot, id, settings),
  removeMap: (docsRoot, id) => ipcRenderer.invoke(Channel.removeMap, docsRoot, id),
  editMapTracker: (docsRoot, id, edit) => ipcRenderer.invoke(Channel.editMapTracker, docsRoot, id, edit),
  removeFromTracker: (docsRoot, id, target) => ipcRenderer.invoke(Channel.removeFromTracker, docsRoot, id, target),
  editMapDocs: (docsRoot, id, edit) => ipcRenderer.invoke(Channel.editMapDocs, docsRoot, id, edit),
  createMapDoc: (docsRoot, id, doc, title) => ipcRenderer.invoke(Channel.createMapDoc, docsRoot, id, doc, title),
  mapDocText: (docsRoot, relPath) => ipcRenderer.invoke(Channel.mapDocText, docsRoot, relPath),
  resolveMapSuggestion: (docsRoot, id, suggestion, accept, pick) => ipcRenderer.invoke(Channel.resolveMapSuggestion, docsRoot, id, suggestion, accept, pick),
  mapJournal: (docsRoot, id, launch) => ipcRenderer.invoke(Channel.mapJournal, docsRoot, id, launch),
  launchMapWork: (request) => ipcRenderer.invoke(Channel.launchMapWork, request),
  previewMapBrief: (request) => ipcRenderer.invoke(Channel.previewMapBrief, request),
  openMapLaunch: (docsRoot, id, launch, terminal, cols, rows) => ipcRenderer.invoke(Channel.openMapLaunch, docsRoot, id, launch, terminal, cols, rows),
  checkMap: (docsRoot, id) => ipcRenderer.invoke(Channel.checkMap, docsRoot, id),
  openMapPullRequest: (docsRoot, id, launch) => ipcRenderer.invoke(Channel.openMapPullRequest, docsRoot, id, launch),
  sendMapFeedback: (docsRoot, id, launch, kind, cols, rows) => ipcRenderer.invoke(Channel.sendMapFeedback, docsRoot, id, launch, kind, cols, rows),
  requestMapChanges: (docsRoot, id, launch, text, cols, rows) => ipcRenderer.invoke(Channel.requestMapChanges, docsRoot, id, launch, text, cols, rows),
  markMapTicketDone: (docsRoot, id, ticket, include) => ipcRenderer.invoke(Channel.markMapTicketDone, docsRoot, id, ticket, include),
  coordinateMapBatch: (docsRoot, id, batch, cols, rows) => ipcRenderer.invoke(Channel.coordinateMapBatch, docsRoot, id, batch, cols, rows),
  declineMapBatch: (docsRoot, id, batch) => ipcRenderer.invoke(Channel.declineMapBatch, docsRoot, id, batch),
  sendMapMessage: (docsRoot, id, text) => ipcRenderer.invoke(Channel.sendMapMessage, docsRoot, id, text),
  breakDownMap: (docsRoot, id, docs) => ipcRenderer.invoke(Channel.breakDownMap, docsRoot, id, docs),
  cancelMapTurn: (docsRoot, id) => ipcRenderer.invoke(Channel.cancelMapTurn, docsRoot, id),
  answerMapPermission: (docsRoot, id, requestId, decision) => ipcRenderer.invoke(Channel.answerMapPermission, docsRoot, id, requestId, decision),
  onMapEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, docsRoot: string, id: string, event: ThreadEvent): void => listener(docsRoot, id, event)
    ipcRenderer.on(Channel.mapEvent, handler)
    return () => ipcRenderer.off(Channel.mapEvent, handler)
  },
  reviewComments: (root) => ipcRenderer.invoke(Channel.reviewComments, root),
  addReviewComment: (root, anchor, body) => ipcRenderer.invoke(Channel.addReviewComment, root, anchor, body),
  editReviewComment: (root, id, body) => ipcRenderer.invoke(Channel.editReviewComment, root, id, body),
  removeReviewComments: (root, ids) => ipcRenderer.invoke(Channel.removeReviewComments, root, ids),
  sendReviewComments: (root, ids, target) => ipcRenderer.invoke(Channel.sendReviewComments, root, ids, target),
  pullRequest: (root, force) => ipcRenderer.invoke(Channel.pullRequest, root, force),
  pullRequestSent: (root) => ipcRenderer.invoke(Channel.pullRequestSent, root),
  sendPullRequestComments: (root, ids, target) => ipcRenderer.invoke(Channel.sendPullRequestComments, root, ids, target),
  prTemplate: () => ipcRenderer.invoke(Channel.prTemplate),
  setPrTemplate: (text) => ipcRenderer.invoke(Channel.setPrTemplate, text),
  draftPullRequestDefaults: (root, chosenBase) => ipcRenderer.invoke(Channel.draftPullRequestDefaults, root, chosenBase),
  createDraftPullRequest: (root, input) => ipcRenderer.invoke(Channel.createDraftPullRequest, root, input),
  openPullRequestReview: (root, pullRequest) => ipcRenderer.invoke(Channel.openPullRequestReview, root, pullRequest),
  pullRequestCommentable: (root, base, head, relPath) => ipcRenderer.invoke(Channel.pullRequestCommentable, root, base, head, relPath),
  setPullRequestFileViewed: (root, pr, relPath, fingerprint) => ipcRenderer.invoke(Channel.setPullRequestFileViewed, root, pr, relPath, fingerprint),
  postPullRequestComment: (root, pullRequest, head, anchor, body) => ipcRenderer.invoke(Channel.postPullRequestComment, root, pullRequest, head, anchor, body),
  submitPullRequestReview: (root, pullRequest, base, head, input) =>
    ipcRenderer.invoke(Channel.submitPullRequestReview, root, pullRequest, base, head, input),
  sendReviewDraft: (root, anchor, body, target) => ipcRenderer.invoke(Channel.sendReviewDraft, root, anchor, body, target),
  onPullRequestChanged: (listener) => {
    const handler = (_e: IpcRendererEvent, root: string): void => listener(root)
    ipcRenderer.on(Channel.pullRequestChanged, handler)
    return () => ipcRenderer.off(Channel.pullRequestChanged, handler)
  },
  onReviewCommentsChanged: (listener) => {
    const handler = (_e: IpcRendererEvent, root: string): void => listener(root)
    ipcRenderer.on(Channel.reviewCommentsChanged, handler)
    return () => ipcRenderer.off(Channel.reviewCommentsChanged, handler)
  },
  claudeArgs: () => ipcRenderer.invoke(Channel.claudeArgs),
  setClaudeArgs: (text) => ipcRenderer.invoke(Channel.setClaudeArgs, text),
  claudeStatus: () => ipcRenderer.invoke(Channel.claudeStatus),
  claudeSignIn: () => ipcRenderer.invoke(Channel.claudeSignIn),
  onThreadEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, root: string, relPath: string, threadId: string, event: ThreadEvent): void =>
      listener(root, relPath, threadId, event)
    ipcRenderer.on(Channel.threadEvent, handler)
    return () => ipcRenderer.off(Channel.threadEvent, handler)
  },
  lspOpen: (root, languageId, force) => ipcRenderer.invoke(Channel.lspOpen, root, languageId, force, LOAD_ID),
  lspSend: (session, message) => ipcRenderer.send(Channel.lspSend, session, message),
  onLspMessage: (listener) => {
    const handler = (_e: IpcRendererEvent, session: string, message: string): void => listener(session, message)
    ipcRenderer.on(Channel.lspMessage, handler)
    return () => ipcRenderer.off(Channel.lspMessage, handler)
  },
  onLspStatus: (listener) => {
    const handler = (_e: IpcRendererEvent, status: LanguageServerStatus): void => listener(status)
    ipcRenderer.on(Channel.lspStatus, handler)
    return () => ipcRenderer.off(Channel.lspStatus, handler)
  },
  lspStatuses: () => ipcRenderer.invoke(Channel.lspStatuses),
  pluginEntries: (refresh) => ipcRenderer.invoke(Channel.pluginEntries, refresh),
  installPlugin: (name) => ipcRenderer.invoke(Channel.installPlugin, name),
  removePlugin: (name) => ipcRenderer.invoke(Channel.removePlugin, name),
  setPluginServerEnabled: (server, enabled) => ipcRenderer.invoke(Channel.setPluginServerEnabled, server, enabled),
  addCustomServer: (input) => ipcRenderer.invoke(Channel.addCustomServer, input),
  onPluginProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, name: string, line: string): void => listener(name, line)
    ipcRenderer.on(Channel.pluginProgress, handler)
    return () => ipcRenderer.off(Channel.pluginProgress, handler)
  },
  searchThemes: (query) => ipcRenderer.invoke(Channel.searchThemes, query),
  themeVariants: (id) => ipcRenderer.invoke(Channel.themeVariants, id),
  setEditorTheme: (theme) => ipcRenderer.invoke(Channel.setEditorTheme, theme),
  editorTheme: () => ipcRenderer.invoke(Channel.editorTheme),
  readOnlyFile: (root, absolutePath) => ipcRenderer.invoke(Channel.readOnlyFile, root, absolutePath),
  onRemoteUpdate: (listener) => {
    const handler = (_e: IpcRendererEvent, root: string, relPath: string, update: Uint8Array): void =>
      listener(root, relPath, update)
    ipcRenderer.on(Channel.remoteUpdate, handler)
    return () => ipcRenderer.off(Channel.remoteUpdate, handler)
  },
  onFilesChanged: (listener) => {
    const handler = (_e: IpcRendererEvent, change: FilesChanged): void => listener(change)
    ipcRenderer.on(Channel.filesChanged, handler)
    return () => ipcRenderer.off(Channel.filesChanged, handler)
  }
}

contextBridge.exposeInMainWorld('manta', api)
