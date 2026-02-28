Use this tool to edit files. Patch path must be absolute.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one file section ]
*** End Patch

Within that envelope, you get one file operation.
You MUST include a header to specify the action you are taking.
Each operation starts with one of two headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Then one or more "hunks", each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change's [context_after] lines in the second change's [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

- If a code block is repeated so many times in a class or function such that even a single `@@` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple `@@` statements to jump to the right context. For instance:

@@ class BaseClass
@@ 	def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

The full grammar definition is below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
UpdateFile := "*** Update File: " path NEWLINE { Hunk }
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

Example for Update File:
*** Begin Patch
*** Update File: pygorithm/searching/binary_search.py
@@ class BaseClass
@@     def search():
-          pass
+          raise NotImplementedError()

@@ class Subclass
@@     def search():
-          pass
+          raise NotImplementedError()
*** End Patch

Example for Add File:
*** Begin Patch
*** Add File: [path/to/file]
+ [new_code]
*** End Patch

It is important to remember:
- You must only include one file per call
- You must include a header with your intended action (Add/Update)
- You must prefix new lines with ` +` even when creating a new file

All file paths must be absolute paths. Make sure to read the file before applying a patch to get the latest file content, unless you are creating a new file.

IMPORTANT: This tool only accepts string inputs that obey the lark grammar start: begin_patch hunk end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
update_hunk: "*** Update File: " filename LF change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change: (change_context | change_line)+ eof_line?

change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
. You must reason carefully about the input and make sure it obeys the grammar.
IMPORTANT: Do NOT call this tool in parallel with other tools.
