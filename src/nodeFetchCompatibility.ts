import http from 'node:http'
import https from 'node:https'

function disableKeepAlive(agent: http.Agent | https.Agent) {
  const mutableAgent = agent as any as {
    keepAlive?: boolean
    options?: { keepAlive?: boolean }
  }

  mutableAgent.keepAlive = false
  if (mutableAgent.options) {
    mutableAgent.options.keepAlive = false
  }
}

// node-fetch v2 can throw premature-close errors while decompressing gzip
// responses over Node 24's keep-alive global agents.
disableKeepAlive(http.globalAgent)
disableKeepAlive(https.globalAgent)
