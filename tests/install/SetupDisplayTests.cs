using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace AgentBrowser.Installer {
    internal static class SetupDisplayTests {
        static void Check(Control parent) {
            foreach (Control control in parent.Controls) {
                if (!control.Visible) continue;
                if (control is Label && control.Text.Length > 0) {
                    var size = TextRenderer.MeasureText(control.Text, control.Font, new Size(control.ClientSize.Width, Int32.MaxValue), TextFormatFlags.WordBreak);
                    if (size.Height > control.ClientSize.Height + 2)
                        throw new Exception("Clipped label: " + control.Text + " required=" + size.Height + " actual=" + control.Height);
                }
                Check(control);
            }
        }
        [STAThread] public static int Main(string[] args) {
            Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
            Directory.CreateDirectory(args[0]);
            try {
                foreach (float size in new [] {10F, 12.5F, 15F, 20F}) {
                    using (var form = new SetupForm(new [] {"--no-discover", "--no-start", "--no-startup", "--install-dir", Path.Combine(args[0], "synthetic-install")})) {
                        form.Show();Application.DoEvents();
                        form.Font = new Font("Malgun Gothic", size);
                        Application.DoEvents();
                        foreach (int page in new [] {0,1,2,3,4,5,6,7}) {
                            typeof(SetupForm).GetMethod("SetPage", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new object[] {page});
                            Application.DoEvents();Check(form);
                            using(var bitmap=new Bitmap(form.Width,form.Height)) {
                                form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));
                                bitmap.Save(Path.Combine(args[0], "font-" + size + "-page-" + page + ".png"));
                            }
                        }
                        Exception dialogError=null;
                        using(var timer=new Timer{Interval=100}) {
                            timer.Tick+=delegate {
                                foreach(Form dialog in Application.OpenForms) {
                                    if(dialog==form)continue;
                                    timer.Stop();
                                    try {Check(dialog);using(var bitmap=new Bitmap(dialog.Width,dialog.Height)){dialog.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));bitmap.Save(Path.Combine(args[0],"font-"+size+"-advanced.png"));}}
                                    catch(Exception error){dialogError=error;}
                                    dialog.Close();break;
                                }
                            };
                            timer.Start();typeof(SetupForm).GetMethod("ShowAdvanced",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(form,null);
                        }
                        if(dialogError!=null)throw dialogError;
                        form.ClientSize=new Size(720,520);form.PerformLayout();Application.DoEvents();
                        var next=form.Controls.Find("Cancel",true)[0];
                        if(!next.Visible||!form.ClientRectangle.Contains(form.RectangleToClient(next.RectangleToScreen(next.ClientRectangle))))throw new Exception("Navigation clipped on a small window: client="+form.ClientRectangle+" button="+form.RectangleToClient(next.RectangleToScreen(next.ClientRectangle))+" visible="+next.Visible+" parent="+next.Parent.Bounds+" footer="+next.Parent.Parent.Bounds+" bottom="+next.Parent.Parent.Parent.Bounds);
                        form.Close();Console.WriteLine("PASS setup pages, advanced settings and small-window navigation at " + size + "pt");
                    }
                }
                return 0;
            } catch(Exception error) {Console.Error.WriteLine(error.Message);return 1;}
        }
    }
}
