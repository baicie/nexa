param(
  [Parameter(Mandatory = $true)][string] $Executable,
  [Parameter(Mandatory = $true)][string] $WorkingDirectory,
  [Parameter(Mandatory = $true)][string] $ArgumentsBase64
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class NexaPickerSupervisedProcess : IDisposable {
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0x00000000;

    private IntPtr processHandle;
    private IntPtr threadHandle;
    private IntPtr jobHandle;
    private bool resumed;

    internal NexaPickerSupervisedProcess(
        IntPtr processHandle,
        IntPtr threadHandle,
        IntPtr jobHandle,
        uint processId
    ) {
        this.processHandle = processHandle;
        this.threadHandle = threadHandle;
        this.jobHandle = jobHandle;
        ProcessId = processId;
    }

    public uint ProcessId { get; private set; }

    public void Resume() {
        if (resumed) {
            throw new InvalidOperationException("picker probe was already resumed");
        }
        uint previousCount = NexaPickerProcessNative.ResumeThread(threadHandle);
        if (previousCount == 0xFFFFFFFF) {
            throw NexaPickerProcessNative.LastError("ResumeThread");
        }
        resumed = true;
        NexaPickerProcessNative.CloseHandle(threadHandle);
        threadHandle = IntPtr.Zero;
    }

    public int WaitForExit() {
        if (!resumed) {
            throw new InvalidOperationException("picker probe must be resumed before waiting");
        }
        uint waitResult = NexaPickerProcessNative.WaitForSingleObject(processHandle, INFINITE);
        if (waitResult != WAIT_OBJECT_0) {
            throw NexaPickerProcessNative.LastError("WaitForSingleObject");
        }
        uint exitCode;
        if (!NexaPickerProcessNative.GetExitCodeProcess(processHandle, out exitCode)) {
            throw NexaPickerProcessNative.LastError("GetExitCodeProcess");
        }
        return unchecked((int)exitCode);
    }

    public void Dispose() {
        Exception shutdownError = null;
        if (threadHandle != IntPtr.Zero) {
            NexaPickerProcessNative.CloseHandle(threadHandle);
            threadHandle = IntPtr.Zero;
        }
        if (jobHandle != IntPtr.Zero) {
            try {
                NexaPickerProcessNative.TerminateJobAndWait(jobHandle, 5000);
            } catch (Exception error) {
                shutdownError = error;
            }
            NexaPickerProcessNative.CloseHandle(jobHandle);
            jobHandle = IntPtr.Zero;
        }
        if (processHandle != IntPtr.Zero) {
            NexaPickerProcessNative.CloseHandle(processHandle);
            processHandle = IntPtr.Zero;
        }
        if (shutdownError != null) {
            throw new InvalidOperationException(
                "picker probe Job Object shutdown was not confirmed",
                shutdownError
            );
        }
    }
}

public static class NexaPickerProcessNative {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength,
        IntPtr returnLength
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags
    );

    internal static Win32Exception LastError(string operation) {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    internal static void TerminateJobAndWait(IntPtr job, int timeoutMilliseconds) {
        if (!TerminateJobObject(job, 1)) {
            throw LastError("TerminateJobObject");
        }
        var stopwatch = Stopwatch.StartNew();
        while (true) {
            var accounting = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
            if (!QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                ref accounting,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                IntPtr.Zero
            )) {
                throw LastError("QueryInformationJobObject");
            }
            if (accounting.ActiveProcesses == 0) {
                return;
            }
            if (stopwatch.ElapsedMilliseconds >= timeoutMilliseconds) {
                throw new TimeoutException(
                    "picker probe Job Object still had active processes after " +
                    timeoutMilliseconds +
                    " ms"
                );
            }
            Thread.Sleep(10);
        }
    }

    public static NexaPickerSupervisedProcess StartSuspended(
        string executable,
        string[] arguments,
        string workingDirectory
    ) {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) {
            throw LastError("CreateJobObjectW");
        }

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            ref limits,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))
        )) {
            var error = LastError("SetInformationJobObject");
            CloseHandle(job);
            throw error;
        }

        var startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetInheritableStandardHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetInheritableStandardHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetInheritableStandardHandle(STD_ERROR_HANDLE);

        var process = new PROCESS_INFORMATION();
        var commandLine = BuildCommandLine(executable, arguments);
        bool created = CreateProcessW(
            executable,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            IntPtr.Zero,
            workingDirectory,
            ref startup,
            out process
        );
        if (!created) {
            var error = LastError("CreateProcessW");
            CloseHandle(job);
            throw error;
        }

        if (!AssignProcessToJobObject(job, process.hProcess)) {
            var error = LastError("AssignProcessToJobObject");
            TerminateProcess(process.hProcess, 1);
            WaitForSingleObject(process.hProcess, INFINITE);
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            CloseHandle(job);
            throw error;
        }

        return new NexaPickerSupervisedProcess(
            process.hProcess,
            process.hThread,
            job,
            process.dwProcessId
        );
    }

    private static IntPtr GetInheritableStandardHandle(int standardHandle) {
        IntPtr handle = GetStdHandle(standardHandle);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) {
            throw LastError("GetStdHandle");
        }
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
            throw LastError("SetHandleInformation");
        }
        return handle;
    }

    private static StringBuilder BuildCommandLine(string executable, string[] arguments) {
        var commandLine = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments) {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        return commandLine;
    }

    private static string QuoteArgument(string argument) {
        if (argument == null) {
            throw new ArgumentNullException("argument");
        }
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) {
            return argument;
        }

        var quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char current in argument) {
            if (current == '\\') {
                backslashes += 1;
                continue;
            }
            if (current == '"') {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(current);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }
}
"@

$argumentJson = [System.Text.Encoding]::UTF8.GetString(
  [System.Convert]::FromBase64String($ArgumentsBase64)
)
$probeArguments = [string[]] @((ConvertFrom-Json -InputObject $argumentJson))
$supervised = $null
$exitCode = 1
try {
  $supervised = [NexaPickerProcessNative]::StartSuspended(
    $Executable,
    $probeArguments,
    $WorkingDirectory
  )
  [Console]::Out.WriteLine(
    "nexa-ui reference notes picker probe process id: $($supervised.ProcessId)"
  )
  [Console]::Out.Flush()
  $supervised.Resume()
  $exitCode = $supervised.WaitForExit()
} finally {
  if ($null -ne $supervised) {
    $supervised.Dispose()
  }
}
exit $exitCode
