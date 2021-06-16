/* eslint-disable node/no-missing-import */
/* eslint-disable no-console */

/*
CANCELED -> CANCELED
This is send by the target as confirmation of a cancellation request by the update server.

REJECTED -> WARNING
This is send by the target in case an update of a cancellation is rejected, i.e. cannot be fulfilled at this point in time.
Note: the target should send a CLOSED -> ERROR if it believes it will not be able to proceed the action at all.

CLOSED -> ERROR (DDI FAILURE) or FINISHED (DDI SUCCESS or NONE)
Target completes the action either with status.result.finished SUCCESS or FAILURE as result.
Note: DDI defines also a status NONE which will not be interpreted by the update server and handled like SUCCESS.

DOWNLOAD -> DOWNLOAD
This can be used by the target to inform that it is downloading artifacts of the action.

DOWNLOADED -> DOWNLOADED
This can be used by the target to inform that it has downloaded artifacts of the action.

PROCEEDING ->	RUNNING
This can be used by the target to inform that it is working on the action.

SCHEDULED -> RUNNING
This can be used by the target to inform that it scheduled on the action.

RESUMED -> RUNNING
This can be used by the target to inform that it continued to work on the action.
*/

import { constants, hawkBitDDI } from '@awesomeorganization/hawkbit-ddi'

import { promiseQueue } from '@awesomeorganization/promise-queue'
import { resolve } from 'path'

const createSimulator = async ({ controllerId }) => {
  const { polling } = await hawkBitDDI({
    agentOptions: {
      bodyTimeout: 10 * 60e3,
      connections: 5,
      headersTimeout: 60e3,
      keepAliveMaxTimeout: 10 * 60e3,
      keepAliveTimeout: 10e3,
      maxCachedSessions: 1,
      maxRedirections: 10,
    },
    artifactsPath: resolve('../artifacts', controllerId),
    controllerId,
    downloadField: 'download-http',
    gatewayToken: '00000000000000000000000000000000',
    hashAlgorithm: constants.hashes.sha256,
    logger(type, options) {
      console.log(controllerId, type, options)
    },
    tenant: 'DEFAULT',
    url: 'https://hawkbit.eclipseprojects.io',
  })
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await polling()
    if (response instanceof Error) {
      console.error(response)
      continue
    }
    const { action, methods } = response
    switch (action) {
      case 'configData': {
        const configData = await methods.put({
          data: {
            repository: 'github:awesomeorganization/hawkbit-ddi',
          },
          details: ['Hello hawkBit!'],
          execution: constants.execution.closed,
          finished: constants.finished.success,
          mode: constants.mode.merge,
        })
        if (configData instanceof Error) {
          console.error(configData)
        }
        break
      }
      case 'cancelAction': {
        const cancelAction = await methods.postFeedback({
          details: ['Canceled successfully'],
          execution: constants.execution.closed,
          finished: constants.finished.success,
        })
        if (cancelAction instanceof Error) {
          console.error(cancelAction)
        }
        break
      }
      case 'deploymentBase': {
        const deploymentBase = await methods.get()
        if (deploymentBase instanceof Error) {
          console.error(deploymentBase)
        }
        const {
          deployment: { chunks, download, maintenanceWindow, update },
        } = deploymentBase
        switch (maintenanceWindow) {
          case 'available': {
            break
          }
          case 'unavailable': {
            await methods.postFeedback({
              details: ['Successfully rejected updated'],
              execution: constants.execution.rejected,
              finished: constants.finished.success,
            })
            continue
          }
        }
        switch (download) {
          case 'attempt': {
            break
          }
          case 'forced': {
            const promises = []
            const { push } = promiseQueue({
              concurrency: 5, // must be equal to `agentOptions.connections`
            })
            const allArtifacts = []
            for (const { artifacts } of chunks) {
              allArtifacts.push(...artifacts)
            }
            let isAllArtifactsDownloaded = true
            const cnt = 1
            for (const artifact of allArtifacts) {
              promises.push(
                push(async () => {
                  await methods.postFeedback({
                    cnt,
                    details: [`Started to download artifact ${artifact.filename}`],
                    execution: constants.execution.download,
                    finished: constants.finished.success,
                    of: allArtifacts.length,
                  })
                  const bytes = await methods.downloadArtifact(artifact)
                  if (bytes instanceof Error) {
                    console.error(bytes)
                    isAllArtifactsDownloaded = false
                    return methods.postFeedback({
                      cnt,
                      details: [`Artifact ${artifact.filename} cannot be downloaded, ${bytes.message}`],
                      execution: constants.execution.downloaded,
                      finished: constants.finished.failure,
                      of: allArtifacts.length,
                    })
                  }
                  let details
                  switch (bytes) {
                    case 0: {
                      details = [`Artifact ${artifact.filename} already exists`]
                      break
                    }
                    case artifact.size: {
                      details = [`Artifact ${artifact.filename} was downloaded successfully`]
                      break
                    }
                    default: {
                      details = [`Artifact ${artifact.filename} downloading was resumed successfully`]
                      break
                    }
                  }
                  return methods.postFeedback({
                    cnt,
                    details,
                    execution: constants.execution.downloaded,
                    finished: constants.finished.success,
                    of: allArtifacts.length,
                  })
                })
              )
            }
            await Promise.all(promises) // wait while all promises will be resolved
            if (isAllArtifactsDownloaded === false) {
              await methods.postFeedback({
                details: ['Some of artifacts were not downloaded'],
                execution: constants.execution.rejected,
                finished: constants.finished.failure,
              })
              continue
            }
            await methods.postFeedback({
              details: ['Artifact were downloaded successfully'],
              execution: constants.execution.proceeding,
              finished: constants.finished.success,
            })
            break
          }
          case 'skip': {
            await methods.postFeedback({
              details: ['Downloading was skipped successfully'],
              execution: constants.execution.proceeding,
              finished: constants.finished.success,
            })
            break
          }
        }
        switch (update) {
          case 'attempt': {
            break
          }
          case 'forced': {
            await methods.postFeedback({
              details: ['Update was installed successfully'],
              execution: constants.execution.closed,
              finished: constants.finished.success,
            })
            continue
          }
          case 'skip': {
            await methods.postFeedback({
              details: ['Updating was skipped successfully'],
              execution: constants.execution.closed,
              finished: constants.finished.success,
            })
            continue
          }
        }
        break
      }
    }
  }
}

const createSimulators = (count) => {
  for (let i = 0; i !== count; i++) {
    createSimulator({
      controllerId: `hawkbit-ddi-${i}`,
    })
  }
}

createSimulators(10)
