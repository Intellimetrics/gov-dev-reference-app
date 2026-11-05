      * INTAKE-MASTER: one fixed-width record per case, nightly export.
       01  INTAKE-REC.
           05  IR-CASE-ID          PIC 9(8).
           05  IR-CASE-TYPE        PIC X(10).
           05  IR-STATUS           PIC X.
           05  IR-SUBMITTED        PIC 9(8).
           05  IR-HOUSEHOLD        PIC 99.
           05  IR-DAYS-WAITING     PIC 9(3).
           05  IR-SCORE            PIC S9(5)V99 COMP-3.
           05  IR-DISCOUNT         PIC S9(3)V99 USAGE COMP-3.
           05  IR-FILLER           PIC X(5).
