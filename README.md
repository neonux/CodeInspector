# Code Inspector #


## Description ##

TODO:


## Build Instructions ##

From inside the project directory, run:

make

or:

zip -r ../CodeInspector.xpi * -x ".git/*"


## Installation ##

Note that the Code Inspector currently requires a custom Firefox Nightly Debug with
additional patches at https://bugzilla.mozilla.org/show_bug.cgi?id=687134
Drag and drop CodeInspector.xpi in Firefox, follow instructions to install add-on.


## Testsuite ##

To run the tests, you need to build Mozilla from source.
Set environment variable OBJDIR to point to your tree's OBJDIR, then run :

make test


## Legal ##

Licensed under the tri-license MPL 1.1/GPL 2.0/LGPL 2.1.
See LICENSE.txt for details.

The logo icon.png and derivatives are attributed to the W3C and licensed under
CC Attribution 3.0 Unported <http://creativecommons.org/licenses/by/3.0/>.


## More ##

For documentation, feedback, contributions :
http://wiki.mozilla.org/DevTools/Features/CodeInspector
