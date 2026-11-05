| Dependent | Kind | Touches | R/W | Shape risk | Evidence |
|---|---|---|---|---|---|
| `INTBATCH.INTLOAD` | Db2 package | INTAKE, INTAKE_AUDIT | ? | bound SQL not read here | `db2-syspackdep.csv:2`, `db2-syspackdep.csv:3` |
| `INTBATCH.INTRPT` | Db2 package | RPT_DAILY | ? | bound SQL not read here | `db2-syspackdep.csv:7` |
| `INTCICS.INTQ01` | Db2 package | INTAKE | ? | bound SQL not read here | `db2-syspackdep.csv:6` |
| `INTAKE.PKG_EXPORT` | Oracle package body | INTAKE | ? | body not read here | `oracle-all-dependencies.csv:9` |
| `INTAKE.PKG_INTAKE` | Oracle package body | INTAKE, INTAKE_AUDIT | ? | body not read here | `oracle-all-dependencies.csv:2`, `oracle-all-dependencies.csv:3` |
| `INTAKE.PKG_REPORTS` | Oracle package body | via INTAKE.RPT_DAILYINTAKE | ? | body not read here | `oracle-all-dependencies.csv:12` |
| `INTAKE.INTAKE_NIGHTLY_EXPORT` | Oracle scheduler job | via INTAKE.PKG_EXPORT | ? | runs INTAKE.PKG_EXPORT.RUN_NIGHTLY | `oracle-scheduler-jobs.csv:2` |
| `INTAKE.PURGE_REPORT_TEMP` | Oracle scheduler job | via INTAKE.PKG_REPORTS | ? | runs BEGIN INTAKE.PKG_REPORTS.PURGE_TEMP; END; | `oracle-scheduler-jobs.csv:3` |
| `INTAKE.TRG_INTAKE_TOUCH` | Oracle trigger | INTAKE | ? | fires for every writer | `oracle-all-dependencies.csv:7` |
| `INTAKE.RPT_DAILYINTAKE` | Oracle view | INTAKE | R | `SELECT *` | `oracle-all-dependencies.csv:8`, `oracle-view-text.csv:2` |
