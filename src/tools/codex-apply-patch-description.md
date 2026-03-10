Use this tool to edit files with codex-style patch syntax.

Patch envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Each file section starts with one header:

*** Add File: <path>
*** Delete File: <path>
*** Update File: <path>

For update sections, you can optionally rename with:

*** Move to: <new path>

Then include one or more chunks introduced by `@@` (optionally followed by a context header):

@@
@@ class MyClass
@@ def my_function(...)

Inside each update chunk, every line must start with one of:

- ` ` (space): context line
- `-`: removed line
- `+`: added line

Optional EOF anchor:

*** End of File

Grammar:

Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Chunk }
MoveTo := "*** Move to: " path NEWLINE
Chunk := "@@" [ header ] NEWLINE { ChunkLine } [ "*** End of File" NEWLINE ]
ChunkLine := (" " | "-" | "+") text NEWLINE

Important constraints:

- Paths must be relative (absolute paths are rejected)
- `*** Begin Patch` and `*** End Patch` are required
- Multiple file operations are supported in a single patch
