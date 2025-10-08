import {Profile, FrameInfo, CallTreeProfileBuilder} from '../lib/profile'
import {getOrInsert} from '../lib/utils'
import {TimeFormatter} from '../lib/value-formatters'

interface Allocations {
  frames: any[]
  sites: any[]
  sizes: any[]
  timestamps: any[]
}

interface Configuration {
  allocationsMaxLogLength: number
  allocationsSampleProbability: number
  bufferSize: number
  sampleFrequency: number
  withAllocations: boolean
  withMarkers: boolean
  withMemory: boolean
  withTicks: boolean
}

interface Lib {
  arch: string
  breakpadId: string
  debugName: string
  debugPath: string
  end: any
  name: string
  offset: number
  path: string
  start: any
}

interface Meta {
  abi: string
  asyncstack: number
  debug: number
  gcpoison: number
  interval: number
  misc: string
  oscpu: string
  platform: string
  processType: number
  product: string
  shutdownTime?: any
  stackwalk: number
  startTime: number
  toolkit: string
  version: number
}

interface PausedRange {
  endTime: number
  reason: string
  startTime: number
}

type Frame = [number] | [number, number | null, number | null, number, number]

interface FrameTable {
  data: Frame[]
  /*
  schema: {
    location: 0
    implementation: 1
    optimizations: 2
    line: 3
    category: 4
  }
  */
}

interface MarkerMeta {
  category: string
  interval: string
  type: string
}
type Marker = [number, number] | [number, number, MarkerMeta]

interface Markers {
  data: Marker[]
  /*
  schema: {
    name: 0
    time: 1
    data: 2
  }
  */
}

type Sample = [number, number, number] | [number, number, number, number, number]

interface Samples {
  data: Sample[]
  /*
  schema: {
    stack: 0
    time: 1
    responsiveness: 2
    rss: 3
    uss: 4
  }
  */
}

export interface StackTable {
  data: [number | null, number][]
  /*
  schema: {
    prefix: 0
    frame: 1
  }
  */
}

export interface Thread {
  frameTable: FrameTable
  markers: Markers
  name: string
  pid: number
  processType: string
  registerTime: number
  samples: Samples
  stackTable: StackTable
  stringTable: string[]
  tid: number
  unregisterTime?: any
}

export interface FirefoxCPUProfile {
  libs: Lib[]
  meta: Meta
  pausedRanges: PausedRange[]
  processes: any[]
  threads: Thread[]
}

export interface FirefoxProfile {
  allocations: Allocations
  configuration: Configuration
  duration: number
  fileType: string
  frames: any[]
  label: string
  markers: any[]
  memory: any[]
  profile: FirefoxCPUProfile
  ticks: any[]
  version: number
}

export function importFromFirefox(firefoxProfile: any): Profile {
  const cpuProfile = firefoxProfile

  const thread =
    cpuProfile.threads.length === 1
      ? cpuProfile.threads[0]
      : // : cpuProfile.threads.find(t => t.tid === 16525513)
        cpuProfile.threads.find(
          t => t.name === 'GeckoMain' && t.processName === 'Isolated Web Content',
        )

  console.log({thread, samples: thread.samples})

  const frameKeyToFrameInfo = new Map<string, FrameInfo>()

  function extractStack(stackFrameId: number | null): FrameInfo[] {
    // let stackFrameId: number | null = sample[0]
    const ret: number[] = []

    while (stackFrameId != null) {
      const nextStackId = thread.stackTable.prefix[stackFrameId]
      const frameId = thread.stackTable.frame[stackFrameId]
      // const nextStackFrame: [number | null, number] = thread.stackTable.data[stackFrameId]
      // const [nextStackId, frameId] = nextStackFrame
      ret.push(frameId)
      stackFrameId = nextStackId
    }
    ret.reverse()
    // if (ret[0] !== 0) {
    //   console.log({root: ret[0]})
    // }
    return ret
      .map(frameId => {
        // const name = thread.funcTable.name[thread.frameTable.func[f]]
        // const frameData = thread.frameTable.nativeSymbol[f]

        const funcIdx = thread.frameTable.func[frameId]

        const name = firefoxProfile.shared.stringArray[thread.funcTable.name[funcIdx]]

        const file = firefoxProfile.shared.stringArray[thread.funcTable.fileName[funcIdx]]

        const line = thread.funcTable.lineNumber[funcIdx]
        const col = thread.funcTable.columnNumber[funcIdx]

        const relevantForJS = thread.funcTable.relevantForJS[funcIdx]

        const match = ['', name, file, line, col]

        if (name.startsWith('0x') && !file) {
          return null
        }

        const location = match.toString()

        if (!relevantForJS) {
          // return null
        }

        // ANYTHING (ANYTHING:999)

        // const match = /(.*)\s+\((.*?)(?::(\d+))?(?::(\d+))?\)$/.exec(location)

        // console.log({location})

        // if (!match) return null

        if (
          match[2] &&
          (match[2].startsWith('resource:') ||
            match[2] === 'self-hosted' ||
            match[2].startsWith('self-hosted:'))
        ) {
          // Ignore Firefox-internals stuff
          return null
        }

        return getOrInsert(frameKeyToFrameInfo, location, () => ({
          key: location,
          name: match[1]!,
          file: match[2]!,

          // In Firefox profiles, line numbers are 1-based, but columns are
          // 0-based. Let's normalize both to be 1-based.
          line: match[3] ? parseInt(match[3]) : undefined,
          col: match[4] ? parseInt(match[4]) + 1 : undefined,
        }))
      })
      .filter(f => f != null) as FrameInfo[]
  }

  const startTime = firefoxProfile.meta.profilingStartTime

  const profile = new CallTreeProfileBuilder(
    firefoxProfile.meta.profilingEndTime - firefoxProfile.meta.profilingStartTime,
  )

  let prevStack: FrameInfo[] = []

  let time = thread.samples.time

  if (!time && thread.samples.timeDeltas) {
    time = []
    let t = 0

    for (const delta of thread.samples.timeDeltas) {
      t += delta
      time.push(t)
    }
  }

  thread.samples.time = time

  console.log({
    time: thread.samples.time.length,
    stack: thread.samples.stack.length,
    eventDelay: thread.samples.eventDelay.length,
  })
  for (let idx = 0; idx < thread.samples.time.length; idx += 1) {
    const stackFrameId = thread.samples.stack[idx]
    const stack = extractStack(stackFrameId)
    // if (stack.length > 0) {
    // console.log({stack})
    // }
    const value = thread.samples.time[idx] - startTime
    // sample[1]

    // Find lowest common ancestor of the current stack and the previous one
    let lcaIndex = -1

    for (let i = 0; i < Math.min(stack.length, prevStack.length); i++) {
      if (prevStack[i] !== stack[i]) {
        break
      }
      lcaIndex = i
    }

    // Close frames that are no longer open
    for (let i = prevStack.length - 1; i > lcaIndex; i--) {
      profile.leaveFrame(prevStack[i], value)
    }

    for (let i = lcaIndex + 1; i < stack.length; i++) {
      profile.enterFrame(stack[i], value)
    }

    prevStack = stack
  }

  for (let i = prevStack.length - 1; i >= 0; i--) {
    profile.leaveFrame(
      prevStack[i],
      firefoxProfile.meta.profilingEndTime - firefoxProfile.meta.profilingStartTime,
    )
  }

  profile.setValueFormatter(new TimeFormatter('milliseconds'))
  return profile.build()
}
