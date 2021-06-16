/* eslint-disable node/no-unsupported-features/node-builtins */
/* eslint-disable node/no-unsupported-features/es-syntax */

export const constants = {
  download: {
    attempt: 'attempt',
    forced: 'forced',
    skip: 'skip',
  },
  execution: {
    canceled: 'canceled',
    closed: 'closed',
    download: 'download',
    downloaded: 'downloaded',
    proceeding: 'proceeding',
    rejected: 'rejected',
    resumed: 'resumed',
    scheduled: 'scheduled',
  },
  finished: {
    failure: 'failure',
    none: 'none',
    success: 'success',
  },
  hashes: {
    md5: 'md5',
    sha1: 'sha1',
    sha256: 'sha256',
  },
  maintenanceWindow: {
    available: 'available',
    unavailable: 'unavailable',
  },
  mode: {
    merge: 'merge',
    remove: 'remove',
    replace: 'replace',
  },
  update: {
    attempt: 'attempt',
    forced: 'forced',
    skip: 'skip',
  },
}

export const hawkBitDDI = async ({
  agentOptions,
  artifactsPath,
  controllerId,
  downloadField,
  gatewayToken,
  hashAlgorithm,
  logger,
  targetToken,
  tenant,
  url,
}) => {
  const crypto = await import('crypto')
  const fs = await import('fs')
  const path = await import('path')
  const undici = await import('undici')
  const timer = {
    _ms: 0,
    get promise() {
      if (this._ms === 0) {
        this._ms = 30e3
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        setTimeout(resolve, this._ms)
      })
    },
    set sleep(value) {
      const multiplier = [3600000, 60000, 1000].values()
      this._ms = value.split(':').reduce((ms, iterator) => {
        return ms + parseInt(iterator, 10) * multiplier.next().value
      }, 0)
    },
  }
  const cache = new Map()
  const agent = new undici.Agent(agentOptions)
  const pollingURL = new URL(`/${tenant}/controller/v1/${controllerId}`, url)
  const headers = {}
  if (gatewayToken !== undefined) {
    headers.authorization = `GatewayToken ${gatewayToken}`
  }
  if (targetToken !== undefined) {
    headers.authorization = `TargetToken ${targetToken}`
  }
  try {
    await fs.promises.mkdir(artifactsPath, {
      recursive: true,
    })
    // eslint-disable-next-line no-empty
  } catch {}
  const hawkBit = async ({ endpoint, etag, isArtifact, method, offset, payload }) => {
    const requestOptions = {
      headers: {
        ...headers,
      },
      idempotent: true,
      method,
      origin: endpoint.origin,
      path: endpoint.pathname,
    }
    if (etag !== undefined) {
      requestOptions.headers['if-none-match'] = etag
    }
    if (offset !== undefined) {
      requestOptions.headers.range = `bytes=${offset}-`
    }
    if (payload !== undefined) {
      requestOptions.body = JSON.stringify(payload)
      requestOptions.headers['content-type'] = 'application/json'
    }
    if (typeof logger === 'function') {
      logger('request', requestOptions)
    }
    let response
    try {
      response = await agent.request(requestOptions)
    } catch (error) {
      response = error
    }
    if (response instanceof Error) {
      return response
    }
    const result = {
      headers: response.headers,
      statusCode: response.statusCode,
    }
    if (isArtifact === true) {
      if (typeof logger === 'function') {
        logger('response', result)
      }
      result.body = response.body
      return result
    }
    result.body = ''
    for await (const chunk of response.body.setEncoding('utf8')) {
      result.body += chunk
    }
    if (result.body === '') {
      delete result.body
    }
    if (typeof logger === 'function') {
      logger('response', result)
    }
    return result
  }
  const artifact = async ({ endpoint, filename, hashes, size }) => {
    const filepath = path.join(artifactsPath, filename)
    const hash = crypto.createHash(hashAlgorithm)
    let digest
    let offset
    let writeStream
    try {
      const stat = await fs.promises.stat(filepath)
      if (stat.size > 0 && stat.size <= size) {
        offset = stat.size
      }
      // eslint-disable-next-line no-empty
    } catch {}
    if (offset === size) {
      const readStream = fs.createReadStream(filepath, {
        encoding: 'binary',
        flags: 'r',
      })
      for await (const chunk of readStream) {
        hash.update(chunk, 'binary')
      }
      digest = hash.digest('hex')
      if (digest === hashes[hashAlgorithm]) {
        return 0
      }
      offset = undefined
    }
    const response = await hawkBit({
      endpoint,
      isArtifact: true,
      method: 'GET',
      offset,
    })
    if (response instanceof Error) {
      return response
    }
    switch (response.statusCode) {
      case 200: {
        writeStream = fs.createWriteStream(filepath, {
          encoding: 'binary',
          flags: 'w',
        })
        break
      }
      case 206: {
        const readStream = fs.createReadStream(filepath, {
          encoding: 'binary',
          flags: 'r',
        })
        for await (const chunk of readStream) {
          hash.update(chunk, 'binary')
        }
        writeStream = fs.createWriteStream(filepath, {
          encoding: 'binary',
          flags: 'a',
        })
        break
      }
      default: {
        return Error(`invalid statusCode (${response.statusCode}) value`)
      }
    }
    for await (const chunk of response.body.setEncoding('binary')) {
      hash.update(chunk, 'binary')
      writeStream.write(chunk, 'binary')
    }
    digest = hash.digest('hex')
    if (digest !== hashes[hashAlgorithm]) {
      return Error(`invalid ${hashAlgorithm} (${digest}) value`)
    }
    return offset ?? size
  }
  const json = async ({ endpoint, method, payload }) => {
    const requestId = `${method}${endpoint.origin}${endpoint.pathname}`
    const [etag, resultFromCache] = cache.get(requestId) ?? [] // destructuring support
    const response = await hawkBit({
      endpoint,
      etag,
      method,
      payload,
    })
    if (response instanceof Error) {
      return response
    }
    if (response.statusCode === 304) {
      return resultFromCache
    }
    // unexpected behavior: hawkBit DDI only returns 200 status code
    if (response.statusCode !== 200) {
      return Error(`invalid statusCode (${response.statusCode}) value`)
    }
    // unexpected behavior: hawkBit DDI only returns body on GET
    if (method !== 'GET') {
      return undefined
    }
    let result
    try {
      result = JSON.parse(response.body)
    } catch (error) {
      result = error
    }
    if (result instanceof Error) {
      return result
    }
    if ('etag' in response.headers === true) {
      cache.set(requestId, [response.headers.etag, result])
    }
    return result
  }
  const polling = async () => {
    await timer.promise
    const response = await json({
      endpoint: pollingURL,
      method: 'GET',
    })
    if (response instanceof Error) {
      return response
    }
    timer.sleep = response.config.polling.sleep
    if ('_links' in response === false) {
      return {} // destructuring support
    }
    if ('configData' in response._links === true) {
      const configDataURL = new URL(response._links.configData.href)
      return {
        action: 'configData',
        methods: {
          put({ data, details, execution, finished, mode }) {
            return json({
              endpoint: configDataURL,
              method: 'PUT',
              payload: {
                data,
                mode,
                status: {
                  details,
                  execution,
                  result: {
                    finished,
                  },
                },
              },
            })
          },
        },
      }
    }
    if ('cancelAction' in response._links === true) {
      const cancelActionURL = new URL(response._links.cancelAction.href)
      return {
        action: 'cancelAction',
        methods: {
          get() {
            return json({
              endpoint: cancelActionURL,
              method: 'GET',
            })
          },
          postFeedback({ details, execution, finished }) {
            return json({
              endpoint: new URL(`${cancelActionURL.origin}${cancelActionURL.pathname}/feedback`),
              method: 'POST',
              payload: {
                id: cancelActionURL.pathname.substring(cancelActionURL.pathname.lastIndexOf('/') + 1),
                status: {
                  details,
                  execution,
                  result: {
                    finished,
                  },
                },
              },
            })
          },
        },
      }
    }
    if ('deploymentBase' in response._links === true) {
      const deploymentBaseURL = new URL(response._links.deploymentBase.href)
      return {
        action: 'deploymentBase',
        methods: {
          downloadArtifact({
            _links: {
              [downloadField]: { href },
            },
            filename,
            hashes,
            size,
          }) {
            return artifact({
              endpoint: new URL(href),
              filename,
              hashes,
              size,
            })
          },
          get() {
            return json({
              endpoint: deploymentBaseURL,
              method: 'GET',
            })
          },
          postFeedback({ cnt, details, execution, finished, of }) {
            return json({
              endpoint: new URL(`${deploymentBaseURL.origin}${deploymentBaseURL.pathname}/feedback`),
              method: 'POST',
              payload: {
                id: deploymentBaseURL.pathname.substring(deploymentBaseURL.pathname.lastIndexOf('/') + 1),
                status: {
                  details,
                  execution,
                  result: {
                    finished,
                    progress: {
                      cnt,
                      of,
                    },
                  },
                },
              },
            })
          },
        },
      }
    }
  }
  return {
    polling,
  }
}
